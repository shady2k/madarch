# The historical contract-v1 note in the product-repository spec is a paragraph, not a heading

Change: madarch-64o5.13-heading
Base: 7cbfed93effa7a4e3592b2c522f1cbd1f2760a2d
Tasks: madarch-64o5.13
Kind: no-behavior

## Intent
The reader-removal work left a level-three heading, "Historical contract-v1 requirements (superseded at runtime)", inside a requirement of docs/system/capabilities/product-repository.md. The document gate reads every level-three heading under a requirement as a scenario, cannot read this one, and refuses every commit whose baseline is main. The note becomes a bold paragraph with the same words; no requirement or scenario changes.

## Rationale
A spec-format repair: the gate must read the current spec to judge any change.

## Out of scope
- The content of the historical scenarios below the note.

## Changes to requirements
- product-repository/contract: the historical note's heading becomes a paragraph; text unchanged.

Complete proposed capability: `capabilities/product-repository.md`.

## Coverage
- product-repository/contract: review
