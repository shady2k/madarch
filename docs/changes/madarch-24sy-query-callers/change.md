# Production callers use the asynchronous graph-query engine

Change: madarch-24sy-query-callers
Base: 232c36a012a8989cac2177c8b2e5dea155e394b3
Tasks: madarch-24sy.4.4
Kind: no-behavior

## Intent
Migrate production server graph serving, HTTP rendering, model rendering and model-check view preparation to the asynchronous SQL query port. Keep user-visible graph answers, rendered text, HTTP responses and refusal/error shapes unchanged while using the SQL projection selected by decision 0024.

## Rationale
The existing contracts already specify the query, render, server and model-check behavior. This migration changes the implementation behind those contracts only; keeping the existing interfaces and regression checks preserves observable results while replacing synchronous production use with the asynchronous SQL port.

## Out of scope
Removing LadybugDB and its package/build/install dependencies; changing per-source PGlite HistoryStore files or legacy `.sqlite` refusal; vector providers; publishing; clean-install walks; changing graph, rendering or model-check requirements.

## Changes to requirements
None. This change preserves existing behavior.

## Preserved contracts
- graph-queries/children: same elements and missing-element errors; `server-graphs` and `server-http` tests.
- graph-queries/view: same scoped elements, collapsed relations, context, ordering and query errors; `server-graphs`, `server-http`, and view-render tests.
- graph-queries/as-of: same valid/known/state filtering; `server-graphs` and query conformance tests.
- views/view-set: same landscape and scoped views; `server-http`, `model-check`, and view-set tests.
- views/mermaid: same Markdown pages and errors; `server-http` and Mermaid tests.
- views/likec4: same workspace text and errors; `server-http` and LikeC4 tests.
- server/view: same request/response and refusal contracts; `server-http` tests.
- model-check/compiles: view preparation keeps the same findings and report shape; `model-check` tests.

## Coverage
- graph-queries/children: test
- graph-queries/view: test
- graph-queries/as-of: test
- views/view-set: test
- views/mermaid: test
- views/likec4: test
- server/view: test
- model-check/compiles: test

## Blocking questions
None.

## Design and decisions
Use one file-backed PGlite `AsyncQueryDatabase` owner for each server data folder, with source-scoped query facades. Rebuild a graph from its HistoryStore assertions on first use, apply successful store reports incrementally, clear a removed source through a facade scoped only to that source, and close facades before the owner. Wrap multi-query rendering and model-check preparation in `withSnapshot`. Decision 0024 remains the query-store choice; no synchronous Ladybug production caller remains.

## Acceptance evidence
See the worker report and task records for focused tests, `bun run check`, feature-document gate and independent review. PostgreSQL adapter integration was skipped because `MADARCH_TEST_POSTGRES_URL` was not configured; no CI result is claimed.

## DONE WHEN
Production graph serving, HTTP view routes, rendering and model-check view preparation use `AsyncQueryDatabase`/`AsyncQueryEngine` and preserve the existing query, rendering and error contracts. Shared ownership, scoped clearing, incremental stores and snapshot consistency are covered by focused tests.
