# The fill a reader meets: a page of its own, a badge that counts the pages a run means to write, and one line on the pages it writes

Change: madarch-m38l.23
Base: 96b0558801d17eacdeecd2a604351aca89a62ee2
Tasks: madarch-m38l.23
Kind: behavior

## Intent
A product's wiki is written by a fill that takes minutes: the code is read first, and then the chosen agent writes page after page. Until this change the reader could not see that work. The top bar said «Агент пишет страницы» and nothing else — not whether the run was half done or at its first page, not which page it was writing, not where to look. The pages the run had not reached yet were listed as problems of the product, because a page whose document does not exist yet is, to a reader who does not know a fill is running, a missing page; the Problems page and the status counted them among the product's faults. The product page carried the run as a card of every unit with its path and its call count — the engineer's facts in the reader's way — and a journal link that the app guessed from the page's address rather than read from the server. The word «юнит» stood in the reader's texts, naming the engine's unit of work to a person who thinks in pages.

This change gives the run a place and a measure. The top bar's badge counts the pages written of the pages the run means to write («Агент пишет страницы · 12/18»), carries a mark that moves while the run is live unless the reader's system asks for less motion, and opens a panel of one line: what is being written now, named by the kind's name the manifest declares and the page's own title, the way to the fill page, and the language the pages are written in. The fill is a page of its own at `/k/fill`, like the page of a CI run: who writes, since when, how long it has taken, how much of the work is done, every page the run takes up with its state and, once written, the link to the page and to the page's journal where the machine holds one, the refusals of a page that failed, and — under one summary — the paths and call counts that are the engineer's. The product page says the same in one line and links to that page. A page the running fill has not written yet stops being a problem: the finding carries a `pending` mark the Problems page and the status drop it by, so no word about the fill has to be recognised to know a page is on its way.

## Out of scope
- The fill's own engine and the writer's units: this change reads the run the server already reports and adds the mark a pending page carries; it starts no run and changes no stage.
- Holding or ending the run («Пауза», «Продолжить», «Остановить»): madarch-m38l.17, whose controls stand on the page and in the panel this change lays out.
- The claim that the layout *looks* right. The gated Chromium test measures rectangles, row counts and text against the viewport at 390 and 1150 px and keeps its screenshots; a person's reading of the shots is a separate judgement, and no record here says a picture was looked at.
- A real agent run in a check: every committed test answers the writer with the scripted agent of the test fixtures.

## Rationale
A person who opens the wiki while it fills now learns, without leaving the page they are on, that the product is being written, how far the run is and which page it is at, and can follow it to a page that says all of it. «12/18» is a measure of the run rather than of the work taken up: the writer counts the pages the run means to write before it writes them, so the reader sees how much is left rather than how much was started. A page that is on its way is not a fault of the product, and the mark that says so sits on the finding in the status the server sends, so the reader's language never has to match a phrase to know it. The facts an engineer needs — the path, the calls, the attempts — are still there, one press away, where the reader is not made to read them.

The capability `fill-page` is new: no requirement said how a running fill is seen, and its complete proposed text is in `capabilities/product-wiki.md`.

## Changes to requirements
- product-wiki/fill-page (new): the top bar's badge counts the pages written of the pages the run means to write and opens a one-line panel that names what is being written by kind and title, offers the fill page and the language, opens from the keyboard, places the focus and closes on a press outside it; the panel stands inside a 390 px screen; the fill has a page of its own at `/k/fill` saying who writes, since when, how long, how much is done and every page with its state, its links and its refusals, the engineer's facts under one summary; a page the running fill has not written is dropped from the Problems page and the status by a mark on its finding; a reader's text uses no engine word for the unit of work. Scenarios: `the-badge-counts-the-pages-a-run-means-to-write`, `the-panel-holds-a-phone`, `the-fill-page-names-every-page`, `the-journal-is-linked-only-where-one-holds-the-page`, `a-page-under-way-is-not-a-problem`.

## Preserved contracts

- product-wiki/pages: every page address, its document and its body stay what they were; the product page's writer card becomes one line and links to the fill page, and no document is changed by a status read.
- product-wiki/internationalization: every new label, count and note is written in both languages through the plural families the engine already has, and the ordinary English form is `_other`.
- product-wiki/serve: the status and page answers keep their shape; the status gains the writer's `journal` and `total` fields beside the ones it had, and a pending finding carries its mark as a field rather than in its message.

## Coverage

- product-wiki/fill-page: test, static
- product-wiki/pages: test, static
- product-wiki/internationalization: test, static
- product-wiki/serve: test, static

## Where it is seen

Kind: screen
Place: a product's wiki while its fill writes — the top bar's badge and its panel, the fill page at `/k/fill`, the product page's one line, and the Problems page
Mockup: docs/prototypes/madarch-m38l.1/filling.png

1. A reader opens any page of a product whose fill is writing: the badge says «Агент пишет страницы · 12/18» with a mark that moves, and one press opens a panel saying «Пишется сейчас: Термин Capture», the way to «Заполнение» and the language the pages are written in.
2. The reader opens the fill page: it says which agent writes, since when, how long, how much of the work is done, and lists every page by its kind's name and its title with its state; the written ones link to their page, and the one whose journal the machine holds links to the journal too.
3. A page that failed shows each refusal with the line and the rule, and the path and call counts stand only under «Подробности для инженера».
4. The reader opens the Problems page while the fill writes: the pages the run has not reached are not among the product's problems.
5. The reader narrows the window to a phone's width: the badge, the panel and the fill page hold one row, and the panel stands inside the screen.

## Blocking questions

None.

## Design and decisions
The run's name for a reader is built from two things the manifest and the page already carry: the kind's name in the reader's language, as the kind catalogue names it, and the page's own title. `unitName(unit, kinds, language)` joins them — «Термин Capture», «Правило BR-3» — and falls back to the engine's unit id only where a kind is unknown, which is where the engineer's summary stands. The path, the calls and the write attempts are rendered only inside that summary's details element, so they are a press away and not a line of the page.

The measure is the run's own: the writer reports how many pages the run means to write (`total`) before it writes them, and the badge counts what is written against it. While the run has not counted its pages the badge stands without a count rather than against the units taken up, because a count of what was started is not how far the run is.

The badge's panel is the menu the top bar already had, narrowed to one line of what is being written, a link to `/k/fill` and the language choice; it is a dropdown, so Tab and the down arrow open it, the first control takes the focus, a press outside it or a tab out of it closes it, and its collision handling keeps it inside the window. The gated Chromium test asserts the panel's rectangle against the viewport at 390 px and the page's scroll width against 390, which is a measurement rather than a reading of a screenshot.

The status decides what a pending page is. The server marks the finding of a page that the writing run has not written with `pending: <entity id>`, and while the run writes it leaves that finding out of the status; the Problems page thus drops these pages server-side. The app never sees a phrase to match, so a change of wording cannot turn a page on its way back into a problem.

A journal link is shown where the server says one holds the page: the status carries `journal: true` for a written unit whose page a journal holds, read from the store at the moment of the read, in place of the client's `hasJournal` built from the address. A page written by a run whose journal this machine does not hold has no link at all, which is better than a link to a page that says nothing.

The fill page is a route of the wiki, `/k/fill`, rendered by `FillPage` from the same status every other page reads; it is reachable from the badge's panel and from the product page's line, so a reader on a domain page does not have to go home to find the run.

## Acceptance evidence
Filled at the merge: `bun run check`, `wiki/app`'s `bun run check` and its test files, `test/knowledge-fill-page.test.ts` for the fill page, the naming, the pending mark and the journal link, and the gated `test/wiki-fill-viewport-e2e.test.ts` in Chromium at 390 and 1150 px, where all six of its cases pass — the badge and the panel on a phone, the mark's motion, the naming of every page, the journal link, the fill page after the run with no line left on the product page, and the keyboard walk from the badge through every control the panel offers, the language choices among them and offered, with Escape giving the badge its focus back. Two of those cases were red on the branch and are fixed here in the test, not in the product: the fixture still answered the domain unit with a Markdown page after a domain page became the fields of `src/writer/domain-page.ts`, so the writer refused it and the run ended failed; and the keyboard case took the language choices for the panel's second control, while a failed run puts the failure note's link to Problems there first and the panel still carries the language choices after it. The report pastes the raw red and green lines of every command.

## DONE WHEN
A reader who opens a product's wiki while its fill writes sees how far the run is on the top bar's badge, learns from one press what is being written and where the fill's page is, and opens that page to find every page of the run named by its kind and title with its state, its links and its refusals; the pages the run has not reached are not the product's problems, the journal is linked only where the machine holds it, no reader's text says «юнит», and the panel stands inside a 390 px screen without widening the page.
