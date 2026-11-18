# 0041. Test layers, the fast suite and the measurement suite

Status: accepted by the Architect under the owner directive (ALX-12, 2026-11-18)
Date: 2026-11-18
Task: madarch-x9a7

## Context
No test strategy was ever decided; the suite grew one rule per breakage. On the 0039
stack a file-per-process pass took 194 minutes (results-passA, 312 files): 131 in 94 red
files waiting out bounds of 5–15 minutes, 22 in PostgreSQL starts, 41 of work in green
files. Three fixtures carry most of it: the full `everything` catalogue published by a
draft or init (109 files, 116 min), own store clusters (45 files, 62 min) and plugin
turns in the real sandbox (34 files, 48 min). Only 69 of 378 files reach no database or
process, mostly because `src/product/manifest/workflows.ts` imports the stage registry and
through it the database adapter. The owner: «Основную часть покрываем дешевыми unit
тестами и лишь малую часть интеграционными и еще меньше e2e. Ну до 15 минут я бы еще
понял.» Tests may be rewritten from scratch; no check of behaviour is dropped.

## Decision
1. Three layers by folder — `test/unit`, `test/integration`, `test/e2e` — plus the
   measurement suite in `test/measure` and helpers in `test/support`. What each layer may
   reach is a rule of `check:tests` over the import graph and the syntax tree; a file is
   placed by what it does. The fast suite is a folder, not a computed list (this replaces
   ALX-337 C1).
2. Budgets on CI's shape (4 vCPU, serial): unit ≤ 1.5 min and ≥ 70 % of cases;
   integration ≤ 12 min, ≤ 25 %; end-to-end ≤ 8 min, ≤ 5 %; measurements ≤ 5 min in their
   own job. The full suite stays within fifteen minutes of wall time; raising that total
   needs the owner's word.
3. The graph's writer and key checks are never faked: their meaning is in SQL. They are
   integration tests on small contracts declared by the case, or on the published
   catalogue held as a database template. Only ports with a shared conformance suite are
   faked: `GraphReader` and `PluginSession`; the fakes live in `test/support` only.
4. A case bound is `bound(ms, { measured, on, at })`, at least three times the measured
   time, at most 30 s in integration and 120 s end-to-end, and none in unit. Elapsed time
   is asserted only in `test/measure`, against baselines, in a CI job that blocks `main`.
5. A rewrite carries a check map and a coverage comparison showing every product line
   the old tests covered is still covered; mutation runs on extracted seams are recorded.

> **Note — open question for the Architect:** The agreed serial layer budgets total
> 21.5 minutes (1.5 + 12 + 8), not the fifteen-minute wall limit. Meeting that wall
> limit requires shards; it is not the sum of the serial budgets. The fast suite
> includes unit plus affected integration/end-to-end files, not one folder. Please
> confirm these interpretations before implementing the budget and fast-suite gates.
> No owner-agreed number is changed by this note.

## Consequences
The developer's and reviewer's gate is `bun run check && bun run test:fast`; CI and
acceptance run the full suite and the measurement suite. Seams are cut in product code
where a pure decision sits behind an I/O import (stage declarations, CLI io, orchestrator
policies). No elapsed-time assertion or long bound returns to a functional case, and no
new test file lands in the root of `test/`. Reversal: remove `check:tests` and move the
files back; nothing in storage or public interfaces depends on it.
