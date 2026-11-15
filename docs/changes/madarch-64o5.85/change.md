# A product's home and its calm state when the server is away

Change: madarch-64o5.85
Base: ef989dae1b707459a69421ca1d4bdee54cd6904b
Tasks: madarch-64o5.85
Kind: no-behavior

## Intent
The owner's 0.3.0 walk and its second look: a home that explains the product
before its first fill, shows the repositories init connected, gives the first
fill's instruction and wizard inline, and reads as one designed page; a server
that cannot be reached shows one calm line in the reader's language with the
next retry, keeps the last answer on the page, and never lets a block print a
request's own words.

## Rationale
The owner's words: the first-run home must teach what madarch is, the three
steps and the wizard; «Заполнить…» must look like a button; «Что держит граф»
must name its columns; a fresh product must show its connected repositories
before a fill; and, after a 503 during a restart, «И вот такого не должно
быть. Мы должны как-то визуализировать что бэкенд недоступен.» One banner,
one calm state, a page that keeps its data and recovers by itself.

## Out of scope
- The finished run page's «Осталось: пока неизвестно» line, which belongs to
  madarch-64o5.87 (madarch-fill).
- An offline cache or service worker; the page keeps what it already read.
- Changing how the server starts or restarts.

## Changes to requirements
None. The change realizes the existing product-wiki/app, live, pages, shell,
repositories, overview, presentation and internationalization requirements.

## Preserved contracts
- product-wiki/pages: a page keeps its last answer while the server is away, and reads again when it answers (test)
- product-wiki/app: one client remains the only API surface, and a page's data comes from its page or command reads (static)
- product-wiki/internationalization: every new reader-facing line is in English and Russian (test)

## Coverage
- product-wiki/app: static test mutation review
- product-wiki/live: static test mutation review
- product-wiki/pages: static test mutation review
- product-wiki/shell: static test mutation review
- product-wiki/repositories: static test mutation review
- product-wiki/overview: static test mutation review
- product-wiki/presentation: static test mutation review
- product-wiki/internationalization: static test mutation review

## Where it is seen
Kind: screen
Place: a served product's home at `/`, its catalogue at `/p/catalogue`, a kind's page opened from the sidebar, and a fill run's page at `/p/run`
Mockup: docs/changes/madarch-64o5.85/home-1440.png

1. Open a fresh product's home after `madarch init` while a fill has never run: the guide says what madarch is and the three steps, the recommended set and the wizard stand inline, «Выбрать в каталоге» is a button, and the repository init connected stands under «Репозитории».
2. Stop the server or cut the tunnel while the page is open: one line at the top says the server cannot be reached, the next retry and the time of the data on the page; the page keeps its last counts, dimmed, and «Заполнить…» is disabled with a tooltip saying why.
3. Start the server again, or press «Повторить сейчас»: a 503 while it starts reads «Сервер запускается…»; when it answers the line says «Связь восстановлена» for two seconds, then the page reads again by itself and the dimming lifts.

## Blocking questions
None.

## Design and decisions
The app's one link is a small store: a request that cannot reach the server,
or a 503, reports the loss and a probe asks `GET /api/product` again with
backoff 500 ms to 10 s; a 503 stays «Сервер запускается…» until an answer. The
frame reads one banner, the page keeps its last answer, and a generation moves
on a return so every read asks again. Actions that need the server use the
same state and carry the tooltip. The home's guide and wizard are the existing
preparation panel rendered inline, with the set summarized and the full plan
one press away.

## Acceptance evidence
Static: `bun run check` passed after the merge (tsc, architecture, UI, catalog,
workflows and quarantine); `wiki/app` `bun run check` passed.
Test: `wiki/app` `bun test` passed 101 cases, 0 failures, 493 assertions
after the merge; the offline, 503, dimmed-data and restored cases are in
`wiki/app/src/app.test.tsx` and the Problems network case in
`wiki/app/src/problems.test.tsx`. `bun test test/fill-runs.test.ts
test/wiki-events.test.ts test/knowledge-publication-state.test.ts` passed 21
cases after the merge.
Walk: a fresh `madarch init --template everything` product was served and
opened through an SSH local forward that was killed and restored. Offline the
banner read «No connection to the madarch server — reconnecting…next attempt
in 1 sRetry nowdata as of 01:26 PM»; the sidebar kept its counts, the page was
`data-stale="true"` at opacity 0.6, «Заполнить…» was disabled and its tooltip
read “The server cannot be reached…”, and no block carried a raw error. The
return read “Connection restored”, then the page was online again. Screenshots
at 1440 and 390: `before-*`, `home-*`, `home-ru-*`, `offline-*`,
`offline-ru-*` and `recovered-*` under `/tmp/home-shots`.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
Each item of the owner's walk holds on a fresh product opened through a cut
and restored tunnel: the home explains the product and the first fill, the
repositories init connected stand before any fill, the page reads as one
designed page, and a lost server shows one calm line with a retry and the last
data, never a raw block error, at 1440 and 390.
