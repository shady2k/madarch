# Install assertion-layer prerequisites

Change: madarch-64o5.141
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: madarch-64o5.141
Kind: behavior

## Intent
Install the additive prerequisites for decision 0039 items 25–27 before the
atomic assertion-storage cutover. Install system graph kinds and retained host
identities, require host-issued writer bindings, resolve evidence graph targets,
and retain context parent pins and operation retry identities.

## Out of scope
The final assertion header/value tables, removal of said_by and evidence JSON,
all-reader assertion selection, disputes, question badges and semantic pinned
resolutions land together in the next increment after references-as-edges.
The existing opinion storage remains authoritative in this prerequisite increment.
No replacement fact store or compatibility projection is introduced.

## Changes to requirements
- product-repository/assertion-prerequisites: install system graph identities and host bindings before accepting writes.

## Preserved contracts
- product-repository/contract: existing product declarations and facts remain in their current storage pending the atomic cutover.

## Coverage
- product-repository/assertion-prerequisites: static test mutation review
- product-repository/contract: test review

## Where it is seen
Kind: internal
Place: product startup and graph writer admission
Reason: no screen layout or UI component changes.

1. Start a product and inspect its installed graph system kinds and host sources.
2. Attempt a write with no binding, another product's binding, or a forged binding.
3. Resolve evidence against retained file, blob and commit graph identities.
4. Create a child context, advance its parent, and inspect the retained cutoff.
5. Retry an accepted operation slot and compare its retained assertion UID.

## Design and decisions
The host owns source/principal registration. Caller-provided producer names,
MCP clientInfo and git author display metadata do not grant graph permissions.
Local person attribution remains explicitly local and unverified; retaining a
principal vertex does not assert external authentication. Plugin versions and
agent sessions are execution lineage, not independent competing sources.

System installation and operational registration are graph data. Context pins
and operation retry receipts are graph-core mechanism state. Evidence resolution
returns checked graph targets with typed locators and creates no missing facts.
The next cutover consumes these APIs; it does not infer trusted identities from
legacy strings.

Coordinator decision (2026-11-16, within decision 0039 items 8–9): the catalogue's own person, role, kind and question declarations extend their system kinds and drop their natural keys.
The owner resolved the shipped `person`, `role` and `kind` collision: these
declarations explicitly extend `system:<name>`, retain extra fields and edges,
and drop their natural keys. Identity belongs to the engine system base.
Names, email addresses and accounts are attributes or edges, not identity keys.
No duplicate identity kinds, compatibility aliases, resets or destructive schema
migration are authorized. The same explicit extension rule is applied to active
`question`. Admission uses the actual typed engine base; nullable extension
fields and existing relations remain. Ordinary person bindings grant extension
fields only, never inherited installation fields. Authored edits select those
fields instead of republishing engine-owned values. No reference-as-edge
cutover is included.
The UML `event` starter kind was renamed to `state-event`, keeping its semantic
`uml.event` id; the distinct DDD `domain-event` kind was not replaced.

The owner authorizes running AppArmor-blocked fills unconfined for this
acceptance run. Results are labelled unconfined; they do not prove confinement.
The consistency fixture now copies the shared value-type library along with
starter kinds. Its focused unconfined run passed eight tests. Overlay admission
passed three tests and 49 assertions; all four bounded manual admission mutants
were killed and restored. Authored/extension binding integration passed eleven
tests and 77 assertions. The complete starter published its catalogue and
passed the reader-page walk (GraphQL); this is not a browser-render acceptance.

Known failures remain without weakened assertions: graph-records refuses an
intentional Unix newline filename under the existing immutable `path:v1` schema;
source-follows-fill returns a null commit instead of the expected fill commit.
The path schema is not revised inside this additive prerequisite increment.
Final foreground static check passed with 1,241 architecture entries found and
listed, no added debt, and zero UI architecture violations. Final focused
integration passed 39 tests / 283 assertions across eight files; the separately
named explicit-writer and pinned-plugin startup suites passed three tests / ten
assertions. An earlier seven-suite graph/MCP-related rerun passed 85 tests / 435
assertions. The broader starter run had nine passes and the source commit
failure above; its complete starter catalogue case passed. No full-suite pass,
confinement acceptance or final storage-cutover completion is claimed.


## Acceptance evidence
Integration remains in progress. This document is not a closure record.

- Final foreground prerequisite integration: 28 pass, 166 assertions across eight
  files, including context pins, producer bindings, system installation, evidence
  targets, explicit doors, startup plugin installations and manifest publication.
- Graph writer suite: 38 pass, 175 assertions using a no-PAM native box process.
  Migration, bulk opinions and journal replay also passed their focused cases.
- Foreground MCP integration: 25 pass, 119 assertions, including stable source
  identity, distinct session activity bindings and refusal of partial edge grants
  when the current opinion writer requires the complete edge scope.
- TypeScript check passed at this integration checkpoint.
- Architecture integration fixed parent links through SWC callback argument wrappers,
  recognizes only declared engine vocabulary, and exposes the additive host API
  through `src/assertion-prerequisites.ts`. Architecture regression tests: 40 pass;
  five bounded manual mutations killed and restored. The baseline shrank by 68
  entries, with no new debt (1,309 to 1,241). The full static check passed.
- Full-suite verification, final independent review and the patch series remain
  pending. Final assertion storage and reader cutover are not implemented here.
