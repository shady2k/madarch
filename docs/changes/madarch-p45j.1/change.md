# Training repository generator and answer key

Change: madarch-p45j.1
Base: cae006585e57003534307b997d5006c408797661
Tasks: madarch-p45j.1
Kind: no-behavior

## Intent
Create a deterministic, small training code repository for the ordering and payments slice, with a separate answer key for evaluating wiki extraction.

## Out of scope
- Running the training repository as a production service.
- Including the answer key or generator in generated output.
- Running quality regression in CI.

## Rationale
This repository-local generator and its tests are tooling for the self-filling training workflow. They do not change Madarch product behavior or capability requirements.

## Preserved contracts
- product-repository/manifest: the training repository is generated outside the source checkout and does not change product manifest behavior.

## Coverage
- product-repository/manifest: test

## Blocking questions
None.

## Design and decisions
The generator reads the reference model YAML for authoritative ids and names, writes outside the source tree, then creates a fixed git history using controlled author and committer metadata.

## Acceptance evidence
Pending.

## DONE WHEN
The generator produces the documented repository deterministically, and tests prove key pointers resolve and the key stays outside generated output.
