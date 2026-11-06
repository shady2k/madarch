# A fill runs in a process of its own

Change: madarch-8bdc.2.9
Base: 972a6cd14a6b725ed5def04e7dd7da50691fef76
Tasks: madarch-8bdc.2.9
Kind: no-behavior

## Intent
Moving the wiki's fill onto the one orchestrator ran it inside the server's process, and PGlite runs a statement on the thread that owns it, so a fill's statements would block the wiki's pages. The fill returns to a process of its own, as the owner requires: "Ну он и должен быть отдельным процессом".

## Rationale
The process boundary is what keeps the server's thread free; the routes and pages do not change, so this keeps the requirement rather than changing it.

## Out of scope
What the fill reads and writes; the correctness of its records (madarch-8bdc.2.8).

## Preserved contracts

- server/serves-wiki: unchanged — the routes and their answers stay as they were; the wiki's server never runs a fill's statement (AGENTS.md's lesson of madarch-m38l.4), and the one fill entry stays one, through `src/knowledge/fill-run.ts`.

## Coverage

- server/serves-wiki: test

## Where it is seen

Kind: request
Place: the wiki's status and page routes of a product whose fill is running

1. A person presses the fill button and opens a page while the fill runs; the page answers within the bound rather than waiting on the fill.

## Blocking questions
None.

## Acceptance evidence
Run on the box at fe1d6804: `test/wiki-fill-child-process.test.ts` (a page answers within its bound during a fill, the fill's pid is not the server's, a child killed mid-fill is a stated failure and a press starts again) and `test/wiki-fill-button-walk.test.ts` are green, and `bun run check` exits 0.

## DONE WHEN
While a fill runs, a page of that product answers within the stated bound.
