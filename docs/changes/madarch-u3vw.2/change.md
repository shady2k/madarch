# The top bar's Sync button runs the wiki's one refresh and lists the pages it changed

Change: madarch-u3vw.2
Base: a509cdafc992c1fbcb685076b713a3eee2aed101
Tasks: madarch-u3vw.2
Kind: behavior

## Intent
The top bar gains a visible «Синхронизировать» button. It presses the wiki's one refresh — the same request the fill menu presses, with no second mechanism — and while the run is under way the button is spent. When the run the reader started ends, the wiki lists the pages it changed, each a link to its page with the count beside them; a run that changed no page says so in one line, and a failed run says why behind the failure note the rest of the wiki shows.

The list is the graph's own account of the run: the nodes and edges its work items opened or closed, read as the pages that stand for them now, plus the Markdown pages whose file was read. A first fill or rebuild names every page it wrote; an unchanged refresh names none; a removed page is not named because there is no page left to open. The list is kept beside the store with the run's finishing time, so a restarted server still answers with it, and it is written only for a run that ended cleanly.

## Out of scope
- A second refresh mechanism or a direct call into extraction and enrichment from the app.
- A history of every sync run; only the latest finished run's changed pages are kept.
- Naming a page the run removed, or restoring a previous run's list after a restart during a run.

## Rationale
The owner said he did not see a sync button, and that synchronization is really running the enrichment process again. A top-bar button that presses the existing refresh closes the discoverability gap without adding a mechanism, and the changed-page list answers what the run did rather than leaving the reader with a spinner. Reading the list from the graph's own work items keeps it consistent with the pages the wiki serves and with the run's stored result.

## Changes to requirements
- wiki-sync/top-bar (new): a visible Sync button in the top bar runs the same refresh as the fill menu and is spent while that run is under way. Scenarios: `sync-presses-the-one-refresh`, `sync-is-spent-during-a-run`.
- wiki-sync/changed-pages (new): a clean finished run lists the pages it changed as links with a count, says so when none changed, and keeps that list beside the store across a restart. Scenarios: `a-run-lists-its-changed-pages`, `an-unchanged-run-names-none`, `a-failed-run-does-not-write-the-list`.

## Preserved contracts
- product-wiki/shell: the top bar and the reading shell keep their existing layout and navigation; the button joins the top bar and does not replace the fill menu's path.

## Coverage
- wiki-sync/top-bar: test
- wiki-sync/changed-pages: test
- product-wiki/shell: test

## Where it is seen

Kind: internal
Place: the top bar of a served product wiki, and the list shown when a sync run ends
Reason: the merge carries browser and server assertions, not a committed mockup; the screen is the wiki the product already serves, and the new button and result list are held by those assertions.

1. Open a filled product's wiki and see «Синхронизировать» in the top bar; press it while a run is under way and see the button spent.
2. Let the run finish and read the changed pages as links with their count, or the one line that says no page changed.
3. Restart the server and open the wiki again: the latest clean run's list is still there; a failed run leaves the list unknown rather than empty.

## Blocking questions
None.

## Design and decisions
The app's top bar sends the same POST the fill menu sends and disables the button for the run it started. The server records the nodes and edges the run's work items opened or closed, resolves them to the pages that stand for them now through the manifest's kinds and the current valid version, adds the Markdown pages whose file was read, and writes the result with the run's finishing time beside the store. A first fill names every written page; a no-op refresh names none; a removed page is skipped. The list is written only after a clean finish, so a failed fill or failed agent stage is not remembered as an empty success.

## Acceptance evidence
- PR #189 (`881fd278`) added the top-bar button and changed-page list in `wiki/app/src/knowledge/app.tsx`, the server list in `src/knowledge/changed-pages.ts` and `src/knowledge/product.ts`, and the API shape in `src/knowledge/model.ts`.
- `wiki/app/src/knowledge/knowledge.test.tsx`, `test/knowledge-sync.test.ts`, `test/changed-pages.test.ts` and `test/knowledge-server.test.ts` hold the button, the single request, the spent state, the linked list, the empty line, the failure and the restart behaviour.
