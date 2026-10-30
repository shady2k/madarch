# A run that writes pages can be held where it stands and ended for good, and the badge says which of the two it is

Change: madarch-m38l.17
Base: 96b0558801d17eacdeecd2a604351aca89a62ee2
Tasks: madarch-m38l.17
Kind: behavior

## Intent
Once the wiki could start a fill that writes a product's pages, a person who wanted to read the pages already written, change the pages' language or simply stop the agent had one way out: stop the server. A run could not be held and taken up again, and there was no press that ended a run on purpose — the `stop` the worker knew was the one a dying server sends. A reader who pressed nothing waited for every page the run meant to write, and a reader who shut the server had to start the whole run again.

This change puts the two decisions a person has about a run under their hand. «Пауза» ends the run before the next page and before the next commit: the page being written and the code's commit in progress are finished, nothing further is taken up, the worker says which stage it ended in, and the paused run — its language, its plan, the pages it published and the task it was pressed for — is kept beside the store, so a server that starts again shows the same paused run. «Продолжить» is the fill's own press: the run is taken up at the page the pause left, in the language it kept, with only the remaining plan, so a finished English run switched to Russian is not written twice from page one. «Остановить» ends the run at once, and asks first: the first press names the pages this run has already rewritten and says that they stay, the second ends the run. A stop wins over a pause wherever the two meet — the worker ignores a pause after a stop and clears one it already read, the server reads a late paused message as the stop it was pressed into, and a stop confirmed before the worker exists is carried out when it starts. A page being written when a stop lands is left as it was before the run, a write in flight is answered and its page put back, and nothing is published afterwards. Both controls stand on the fill page and in the top bar's panel, in one row that holds at a phone's width, and the badge carries the run's state as a mark and its count.

## Out of scope
- The fill page, the badge's count and the panel this change adds its controls to: madarch-m38l.23, on which this branch is stacked.
- The graph fill's engine: a pause of the code read stands before the commit it has reached by the engine's own stop-at-commit, which this change uses rather than changes.
- The orchestrator's own cancellation (fill-orchestrator/cancel): a run of the fill's stages keeps its semantics; this change's stop is the wiki's own end of the run that writes pages.
- A real agent run in a check: every committed test answers the writer with the scripted agent of the test fixtures.

## Rationale
Being able to hold a run is what makes a long fill usable: the pages written so far can be read, the language can be changed for the rest, and the machine can be left. Keeping the paused run beside the store is what makes that hold survive a restart — a person who closes the wiki and comes back finds the run where they left it rather than a fresh one that writes the same pages again. A stop is asked twice because it is the one press that cannot be taken back: the question says how many pages this run has already rewritten and that they stay, so the press is made with the consequence in front of the person. A stop that beat a pause — through the worker's mailbox, the server's state or a start that had not happened yet — would otherwise leave a run that ends paused, which is a run that says it can be taken up when it cannot.

The capability `fill-controls` is new: no requirement said how a run that writes pages is held or ended, and its complete proposed text is in `capabilities/product-wiki.md`.

## Changes to requirements
- product-wiki/fill-controls (new): a live run offers «Пауза» and «Остановить» on the fill page and in the top bar's panel in one row, from the moment the fill runs; a pause finishes the page and the commit in progress, ends the run before the next, names the stage it ended in, and keeps the run — language, plan, published pages and task — beside the store across a restart; «Продолжить» takes the run up at the next page in the kept language with only the remaining plan; a stop asks first with the count of pages rewritten and ends the run on the second press, wins over a pause at every layer, leaves the page in progress as it was, answers a write in flight and publishes nothing afterwards; a task run plans its task and a resumed run keeps the task it held; the controls hold one row at 390 px and the badge carries the state's mark and its count. Scenarios: `a-pause-ends-the-run-before-the-next-page`, `a-paused-run-is-kept-across-a-restart`, `a-resume-takes-up-the-next-page`, `a-stop-asks-before-it-ends-the-run`, `a-stop-wins-over-a-pause`, `a-task-run-keeps-its-task`, `the-controls-hold-a-row-at-a-phones-width`.

## Preserved contracts

- product-wiki/pages: the pages the run writes and the address of each stay what they were; a pause, a resume and a stop change what the run does, not what a written page says.
- product-wiki/internationalization: the controls, their states and the stop's question are written in both languages through the plural families the engine already has, and the ordinary English form is `_other`.
- product-wiki/serve: the status and page answers keep their shape; the status gains the run's `paused` and `stopped` states and the write and pause endpoints are new answers in the same envelope as the fill's.

## Coverage

- product-wiki/fill-controls: test, static
- product-wiki/pages: test, static
- product-wiki/internationalization: test, static
- product-wiki/serve: test, static

## Where it is seen

Kind: screen
Place: a product's wiki during a fill — the fill page at `/k/fill`, the top bar's badge and its panel, and the question a stop asks
Mockup: docs/prototypes/madarch-m38l.1/filling.png

1. A reader opens the fill page while the run writes: «Пауза» and «Остановить» stand in one row, and pressing «Пауза» lets the page in progress finish and then says the run is paused with the pages written so far.
2. The reader closes the wiki and opens it again: the run still stands paused at the same pages, and «Продолжить» takes up the next page in the language the run kept.
3. The reader presses «Остановить»: the page asks how many pages this run has already rewritten and says they stay, and the second press ends the run.
4. The reader narrows the window to a phone's width: the controls and the stop's question hold one row inside the screen, and the badge shows the run's state as a mark beside its count.
5. A reader with a screen reader hears the run's whole state sentence as the badge's and the panel's name, not the bare count.

## Blocking questions

None.

## Design and decisions
A pause is a gate in the writer's own loop rather than a message the agent is interrupted with: the writer asks `halt` before each page and, when it is set, throws `WriterHalted`, so the page and the commit in progress are finished and the next page is never taken up. The worker reports the stage it ended in with the stopped message's `paused` flag, which is how the server tells a person's pause from a stop and from its own shutdown.

The paused run is kept beside the store in `src/knowledge/product.ts`: the language, the plan, the pages already published and the task the run was pressed for. A resume reads them, sends only the remaining plan to the worker and filters the completed pages out, so a resumed run does not rewrite what stands. Because the task is part of what is kept, a run started from a task carries its own task and pages rather than reading them from the paused run, which was the fault the last commit of this branch fixes.

A stop is a cancellation with the stop's own cause, and it is answered by the server rather than only sent to the worker: `POST /api/k/stop` without `confirm` answers with the number of pages this run has rewritten and the words that they stay, and with `confirm` it stops the worker. The worker clears a pause it reads after a stop, the server reads a late paused message as the stop it was pressed into, and a stop confirmed before the worker exists is replayed right after the start — three places where the two presses could otherwise cross.

Publication is fenced by the stop: a `write_page` already in flight is answered before the worker reports stopped, and its page is put back as it was before the run. The page in progress is left in that state rather than deleted, because the person asked for the run to end, not for their folder to be emptied.

The graph fill pauses at the commit it stands before by the engine's stop-at-commit, the same boundary: the code read's commit in progress is finished and the next is not taken up, and the resume carries on from that commit.

The controls are one component, `wiki/app/src/knowledge/run-controls.tsx`, drawn on the fill page and in the top bar's panel; the question stands in the flow below the press that asked it, not in a portal, so it cannot escape the popover. The badge carries the state as an icon and the count, and the whole sentence is its accessible name and the panel's, which is what lets it keep one row at 390 px without losing the words to a screen reader.

## Acceptance evidence
Filled at the merge: `bun run check`, `wiki/app`'s `bun run check` and its test files, `test/knowledge-pause-stop.test.ts` with `test/knowledge-fill-page.test.ts` on this branch, and the gated `test/wiki-pause-stop-e2e.test.ts` in Chromium at 390 and 1150 px, where all three of its cases pass — the run under way offering «Пауза» and «Остановить» in one row at both widths, the paused run's one row, its name and its count, and the stop's question and its second press with the pages it rewrote staying. The 1150 px case was red on the branch and is fixed here in the test, not in the product: it built the stop's words by hand with the verb that agrees with two to four pages, while the run had rewritten one and the screen said «Уже переписана 1 страница», which is the locale's `stopWords_one`. The test now reads the plural family from `wiki/app/src/locales/ru.json`, asks `Intl.PluralRules('ru')` for the form of the count the run produced and asserts the whole sentence. The report pastes the raw red and green lines of every command.
## DONE WHEN
A person who watches a fill write a product's pages can hold it where it stands and find it there after a restart, take it up at the next page in the language it kept, or end it for good after being told how many pages this run has rewritten and that they stay; a stop wins over a pause wherever the two meet, nothing is published after a stop, the page in progress is left as it was, and the two controls and the stop's question hold one row at a phone's width.
