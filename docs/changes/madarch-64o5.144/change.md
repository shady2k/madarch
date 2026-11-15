# Approved catalogue dependency tree and explicit unpaged contracts

Change: madarch-64o5.144
Base: 2535d187abbbbd925ab3a3b38dc38bd7ac04e254
Tasks: madarch-64o5.144
Kind: behavior

## Intent
Apply the owner's catalogue tree and the coordinator's explicit catalogue-only prerequisite and deferred-edge contracts.

## Out of scope
Fills, agents, applicability cascade (madarch-64o5.145), federation, reserved-name redesign, page promotion, push and acceptance.

## Changes to requirements
- product-repository/catalogue-tree: whole-life-cycle dependencies and approved concept identities.
- product-repository/catalogue-only-contract: explicit empty prerequisites and waiting edges.

## Preserved contracts
None.

## Coverage
- product-repository/catalogue-tree: test
- product-repository/catalogue-only-contract: test

## Where it is seen
Kind: command
Place: bun run check:catalog and the fill-plan response

1. Run the catalogue check: read 500 kinds, 120 page kinds and five named waiting edges.
2. Request a plan containing a catalogue-only prerequisite: read its no-producer-declared state.
3. Generate schema and storage contracts: waiting edges have neither types nor tables.

## Blocking questions
- Local tracker data is unavailable; no acceptance or tracker transition is claimed.

## Acceptance evidence
Scripted checks only. See the hand-in report for commands and counts. No owner acceptance, independent review or mutation result is claimed.
