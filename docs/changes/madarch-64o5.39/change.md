# Explain kind records to the reader

Change: madarch-64o5.39
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.39
Kind: behavior

## Intent
Replace unfinished database-column explanations on kind pages with the plugin-owned reader contract: meaning, sources, filling plugin, state, available role facts and understandable fields, then records.

## Out of scope
New role-fact aggregation APIs, model execution, graph redesign, rebasing PR278 and changes to fill persistence are excluded. Facts absent from the current contract are reported, not invented.

## Changes to requirements
- product-wiki/presentation: readable kind explanations before and after fixture fill.

## Preserved contracts
None.

## Coverage
- product-wiki/presentation: static test review

## Where it is seen
Kind: request
Place: /kind/code.file in Chromium at 1400 and 390 CSS pixels

1. Open the unfilled scripted fixture and read the kind explanation, sources, producer and state.
2. Read the contract's field meanings and available role facts or catalogue metadata.
3. Fill the fixture using a scripted agent, never a real model.
4. Open the same page and inspect the records and updated state.

## Design and decisions
Branch from the explicitly requested fix/madarch-64o5.31 (PR278); the owner handles rebasing. The contradictory generic main-branch bar is interpreted as the bundle comparison base. No changes from .26 or .27 are included. Only plugins interpret reader data. Do not fabricate facts absent from the contract.

The existing `KindDecl.details` lists the public properties and their order. It
is independent of storage fields. The catalogue projects translated property
labels and only meanings explicitly declared by the same property's bound
producer. The wiki no longer renders SQL/JSON types, nullable signatures or
storage fields. Count is existing catalogue metadata, not a new role-fact API.
Neither the base nor .31 publishes kind-level language/distribution/age facts;
per-file language properties are not such an aggregate. Missing meaning is
stated explicitly. The protocol has one meaning string, not localized meanings;
translated property labels do not imply translated producer text.

## Acceptance evidence
The final /tmp/madarch-64o5.39-report.md records chronological red, focused tests, native checks, actual browser before/after fill at both sizes, source review, limitations and bundle verification. No unperformed mutation, human visual review, owner approval or tracker closure is claimed.
