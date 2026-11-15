# A fill's pages and counts move while the fill runs

Change: madarch-64o5.91
Base: ef989dae1b707459a69421ca1d4bdee54cd6904b
Tasks: madarch-64o5.91
Kind: request

## Intent
A reader who keeps the wiki open while a fill runs sees what the fill has
published as it publishes it: one event for each unit, the kinds it changed
and the facts it wrote, and the sidebar, home counts, catalogue counts and an
open kind's page read only what they show, within about two seconds and
without a reload.

## Rationale
The owner's words: «вот эти разделы появились только в конце заполнения. А у
нас с тобой концепция, что вики заполняется и человек видит изменения сразу.»
The first successful fill published 43 units in 48 s, yet the sidebar gained
«Код → Папки, Файлы, Пакеты, Репозитории» only when the run ended. The wiki
must show each unit's publication while it is still running.

## Out of scope
- The finished run page's «Осталось: пока неизвестно» line, which belongs to
  madarch-64o5.87 (madarch-fill).
- A second transport or a replayed event history; the stream carries live
  notices, and a page's own reads remain its truth.
- Changing the fill's publication cadence or its plugins.

## Changes to requirements
None. The change realizes the existing product-wiki/live, app, pages, shell and
serve requirements for a page that follows a fill.

## Preserved contracts
- product-wiki/live: the change event still carries the graph's revision; kinds and facts are additive fields (test)
- product-wiki/pages: a page's graph answer remains its own read, and no page is drawn by the event (static)

## Coverage
- product-wiki/app: static test mutation review
- product-wiki/live: static test mutation review
- product-wiki/pages: static test mutation review
- product-wiki/shell: static test mutation review
- product-wiki/serve: static test mutation review

## Where it is seen
Kind: request
Place: the product wiki's home at `/`, its sidebar, its catalogue at `/p/catalogue`, and an open kind's page while a fill runs

1. Start a fill on a product whose code has new files, and open the run page with the sidebar visible.
2. Before the run ends, the sidebar gains the kinds the units publish and its counts grow; the changed kind rows flash once.
3. The home's «Что держит граф» and the catalogue's per-kind counts show the same numbers, and an open kind's page shows the newly published entities without a reload.

## Blocking questions
None.

## Design and decisions
The change stream carries one notice for each unit publication: the kinds it
wrote and the facts it wrote. The api role follows the fill role's durable
progress on its status polls; a poll can see the store move before the
progress row lands, so an active run is read on every poll, and a scoped unit's
kind is normalized to the graph's kind. The client reads its navigation only
for a unit notice (sidebar, home kind counts, catalogue counts), re-asks an
open kind page only when its kind changed, and re-asks the home for templates
that still read counts from their own query; changed kinds wear a two-second
highlight. A structure notice (a run's state or the product's files moving)
still reads the bootstrap again. The home's «Что держит граф» now reads the
frame's navigation, one answer for the sidebar and the home.

## Acceptance evidence
Static: `bun run check` passed after the merge (tsc, architecture, UI, catalog,
workflows and quarantine); `wiki/app` `bun run check` passed.
Test: `wiki/app` `bun test` passed 101 cases, 0 failures after the merge; the
unit-publication case grows the sidebar from zero, keeps the bootstrap at one
read and checks the highlight in `wiki/app/src/app.test.tsx`. The stream
payload is tested in `test/wiki-events.test.ts`; `test/fill-runs.test.ts` and
`test/knowledge-publication-state.test.ts` passed 21 cases with it.
Walk: on the fresh product, a real fill published 18 units. The sidebar gained
`Directories 150` and `Repositories 2` at 2.8 s, `Files 600` at 4.1 s and
`Packages 5` at 5.1 s while the run was still `running`; the run ended at
6.1 s. The captured stream read `{"revision":"2","kinds":["code.repository"],
"facts":1}` and `{"revision":"5","kinds":["code.file"],"facts":0}`; the
screenshot is `/tmp/home-shots/fill-sidebar-1440.png`.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
During a fill the sidebar gains the section and its counts grow before the run
ends; the home's counts, the catalogue's per-kind counts and an open kind's page
show the same publication within about two seconds, without a reload, and the
changed kinds are highlighted.
