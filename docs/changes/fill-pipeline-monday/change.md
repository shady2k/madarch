# The fill pipeline's Monday slice

Change: fill-pipeline-monday
Base: cae006585e57003534307b997d5006c408797661
Tasks: madarch-tzte.1, madarch-tzte.2, madarch-tzte.3, madarch-tzte.4, madarch-tzte.5, madarch-tzte.7, madarch-p45j.1, madarch-p45j.2, madarch-p45j.3, madarch-p45j.4, madarch-co2d.1, madarch-co2d.2
Kind: behavior

## Intent
Deliver the agreed Monday 2026-10-19 morning slice of self-filling outcomes 3–5: a small resumable agent-orchestrated pipeline that can fill a product wiki from code and its own documents, show evidence and assumptions honestly, let a person watch/pause/stop and answer questions, and always suggest a next step. The pipeline is an orchestrator made of bounded units, not one agent session. The kinds and how to find them come from the product registry; the engine stores no product-kind vocabulary.

## Rationale
The owner agreed the design on 2026-10-16. This change records the Monday scope from `docs/milestones/self-filling.md`, including its training repository checkpoint. It does not reopen the charter's decisions.

## Out of scope
- Background server lifecycle, service install, server/team mode, connectors with tokens, sign-in.
- Rich editor, comment replies, accept/reject workflow, update on default-branch commits, fetching external links, automatic question closure.
- PostgreSQL/PGlite implementation: temporary operational state is files under `.madarch/` until PGlite lands.
- Any kind, form or product data hard-coded into the engine.

## Changes to requirements
- product-wiki/fill: bounded resumable fill with source-backed claims, unverified assumptions, typed questions, progress, and next steps.

## Preserved contracts
- product-wiki/pages: product Markdown remains truth in git; intended, extracted and inferred layers remain distinct.
- product-repository/contract: registry data declares kinds and discovery; engine embeds no product kinds.

## Coverage
- product-wiki/fill: test
- product-wiki/pages: test
- product-repository/contract: test

## Design and decisions
See `design.md` for the buildable design, formats, stage dependencies, invocation boundaries, persistence and UI behavior.
