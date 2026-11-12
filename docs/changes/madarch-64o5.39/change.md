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
Integrated .31 declaration/source labels and .24 stable filtering, pagination and FilterResults remain intact. Details render before usage, map and records.

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
Independent integration branch from origin/integration/2026-11-12c at 59c5f624. Cherry-pick only 62d630b66c6a9efd829464295b609dcc5dbe81c3: .31 is already integrated and is not replayed. The pick applies cleanly and preserves the integrated filter/pagination implementation. No changes from .26, .27 or .38 are included. Only plugins interpret reader data. Do not fabricate facts absent from the contract.

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
Historical source evidence is recorded in /tmp/madarch-64o5.39-report.md; it is not a fresh integration pass. Fresh native focused tests, wiki check/build, persisted scripted ACP before/after fill browser evidence at 1400/390 EN, source hashes and bundle verification are recorded in /tmp/i39-report.md and /tmp/i39-* artifacts. No full root suite, human visual review, owner approval or tracker closure is claimed. The docs gate remains onlyownerapproval.
