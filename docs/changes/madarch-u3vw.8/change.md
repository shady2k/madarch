# The menu's status answer is made from the inputs it names now: a renamed product, a written template, a moved branch or an applied correction reaches the next poll, and a Problems count is never carried from other inputs

Change: madarch-u3vw.8
Base: b96a5904b45283d085992317c962f9509691a437
Tasks: madarch-u3vw.8
Kind: behavior

## Intent
The menu of a served product wiki polls `GET /api/k/status`. It showed a product renamed on disk under its old name, kept a kind refused for a missing template after the template was written, counted a task open after a commit on its repository's default branch had closed it, and could show the Problems count collected for earlier inputs. The answer's cache key named files by size and modification time, left out the product manifest and the template paths of refused declarations, and ignored the commits a task closure reads. A Listing that landed after the answer was made could also leave the old open count in the menu.

The branch changed the key to content stamps, added the product manifest and every declared template path, added the tasks folder, the store's last finish and each task repository's default-branch tip, and made the status answer take the Problems count only from the listing for exactly its inputs. It then withheld the count whenever its cached listing was for an older key, even when no fill was running, so the first training-loop run's status carried no `problemsOpen` while `/api/k/problems` returned 72. The tests compared those two answers and failed.

This change closes that gap in the product: when no fill runs, a reader that finds the Problems inputs changed collects the listing for those inputs and answers with its count, retaking the key after the store is open; only a running fill leaves the count pending. The menu therefore shows the count the Problems page shows on the poll after a fill, while a count collected for other inputs is still never carried.

## Rationale
A menu that answers with an older product, kind or task count is worse than no menu: a person trusts it to say what the product is now, without reloading the page or restarting the server. The same is true of the Problems figure — it is read beside the Problems page, and the two must name one count. The branch had the freshness rule right but made "pending" outlive the fill that justified it. Collecting once when idle keeps both promises: the answer is for the inputs the person sees, and a fill's suppressed collection is not mistaken for a count of other inputs.

No capability described the menu's status answer: `product-wiki` covered the served wiki and live pages, but not the polled body, its key, or its Problems count. The capability gains `status` and `problems-count`, and the complete proposed text is `capabilities/product-wiki.md`.

## Out of scope
- What the Problems page lists, how a problem is dismissed, and how its listing is resolved: this change only makes the status count the open count of the listing for its own inputs.
- Collecting the listing while a fill runs: the fill continues to hold that collection back, and the answer omits the count until the fill ends.
- Any new field of the status answer, any change to the menu's markup, its polling interval or its wording: the menu and the route keep their shapes.
- A real model run, a fill against a live agent or a change to the tracker: every check here uses fixtures and scripted or held fills.

## Changes to requirements
- product-wiki/status (new): the polled answer is made from the inputs as they stand, its cache key names every input by content, the tasks folder, the last finish and each default-branch tip, and a template path is stamped before either the template or its Liquid fallback exists. Scenarios: `renamed-product`, `equal-size-edit-with-restored-mtime`, `template-written-after-refusal`, `default-branch-commit-closes-task`.
- product-wiki/problems-count (new): `loop.problemsOpen` is present only as the open count of the Problems listing for the answer's own inputs; an idle reader collects a missing or stale listing, a running fill leaves the count absent, and the next answer after the fill collects it. Scenarios: `applied-correction`, `pending-during-fill`, `fallback-template-counted`.

The complete proposed capability text is `capabilities/product-wiki.md`. It is the whole current capability with the two requirements added before `serve`, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: the pages the wiki makes from the product's documents, their addresses, titles and links keep their behaviour; the status answer changes only what it reads and when its count is present.
- product-wiki/live: a page still follows its file as it is saved, and the status poll still notices a document or manifest edit on the next answer.
- product-wiki/serve: `GET /api/k/status` keeps its address and its answer shape; no response field is renamed or removed, and a menu that shows the fallback corrections count while the Problems count is pending still receives `correctionsOpen`.

## Coverage
- product-wiki/status: test
- product-wiki/problems-count: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test

## Where it is seen

Kind: internal
Place: the menu of a served product wiki, which polls `GET /api/k/status`, and the Problems count it shows beside the Problems page
Reason: no screen, command or message is added: what a person reaches is the same menu and the same Problems page, and what changes is that the menu's name, kinds, task count and Problems figure are for the inputs it now sees, including the first poll after a fill. No mockup is judged, because no drawing changes.

1. Serve a product and let its menu poll once: note the product name, the kinds, the open task count and the Problems count.
2. Rename the product, write a template its manifest already named, or land a commit that closes one of its tasks; after one poll the menu names the new product, the new kind or the closed task, without a reload or a server restart.
3. Start a fill and mark a correction applied: while the fill runs the menu does not keep the previous Problems count; after the fill ends, the next poll shows the Problems page's new open count.
4. Open the Problems page and compare its open count with the menu's figure: they are the same count for the same inputs.

## Blocking questions
None.

## Design and decisions
**The key names content.** `statusKey()` is the Problems listing's own key plus three inputs the listing leaves out: the tasks folder, the store's `last-fill.json`, and each task repository's default-branch commit. The listing key already names the snapshot, the pins, the writer's unplaced plan, the starter offers, the product manifest, the kinds manifest, every declared template path, the Markdown kind files, the product documents, the questions and corrections folders, and the store's identities and classifications. Each file enters by a content hash, not by size and modification time: the hash is remembered beside the stat fields, and an edit that keeps the size and restores the mtime still changes the ctime and is hashed again. A template path is compared as a stat per declared path, with the Liquid fallback of a named `.md` added before either file exists.

**The answer never carries a count from another key.** `statusNow()` asks `openProblems()` for a count and its key, then retakes the Problems key after making the body; only a retaken key equal to the count's key is remembered with the memo. `statusLive()` patches a counted body from the listing cache only when that cache's key is the answer's Problems key, and strips `problemsOpen` from a body whose count is pending. That strip is why a pending answer does not fall back to the corrections count as if it were the Problems count; `correctionsOpen` remains in the body for the menu's fallback display.

**The pending state belongs to a running fill.** The branch's `openProblems()` collected a listing only when the cache was empty and no fill ran. A stale cached listing sent every idle reader down `refreshProblems()` and returned `undefined`, so a body made just after a fill could be memoized as pending and answer without a count even though nothing was collecting. The fix makes the idle path collect: `openProblems()` opens the store, recomputes the key, collects the listing for exactly that key and returns its open count. While `this.fill.state === 'running'` it still starts no collection and returns `undefined`, and a pending memo is not reused once the fill is no longer running. The key is taken after the store is open because opening the store first time carries the reader's revision; without that retake the first poll of a product could look like inputs that changed under it and lose its count.

**A failed collection is not polled to death.** A collection failure leaves the count absent and records the key in `problemsFailed`; the menu's next polls do not walk the graph again until the inputs change or a listing lands. That keeps a broken store from turning every poll into a new failure while still recovering on the next edit.

**Why the test is not weakened.** `test/loop-training.test.ts` asserts that the status answer and `/api/k/problems` name one open count, first with the questions unanswered and again after one answer; on the red run both resolved to 72. Hiding the count, renaming the field or skipping the comparison would remove the only check that the menu and the Problems page agree. The product path is fixed instead, and the test is left as it was.

## Acceptance evidence
Red on the transferred head `c69de3e3`, before any edit: `PATH=/root/.bun/bin:$PATH bun test test/loop-training.test.ts` ran 9 tests, 2 failed, exit 1. The first failure at `test/loop-training.test.ts:117` expected `{questionsOpen:6, questionsAnswered:0, correctionsOpen:0, tasksOpen:0, problemsOpen:72}` and received the same object without `problemsOpen`; the second at `:169` expected `{questionsOpen:5, questionsAnswered:1, correctionsOpen:0, tasksOpen:0, problemsOpen:72}` and received it without `problemsOpen`. In the same run `/api/k/problems` answered `open: 72`, so the status and the Problems page disagreed.

Green with the product fix, after `bun install --frozen-lockfile` in the root and `wiki/app`: `bun test test/loop-training.test.ts` ran 9 tests, 9 passed, 0 failed, exit 0. `bun run check` (`tsc --noEmit`) exited 0.

Committed as `8d1b695a` — `Collect the Problems count after the fill that held it back`, with `Task: madarch-u3vw.8`. `origin/main` was then merged as `9e3e3448` — `Merge origin/main (b96a5904) into fix/madarch-u3vw8-status-freshness`, also carrying the trailer; the merge changed `src/knowledge/product.ts` only by main's context and kept the count path.

After the merge, on `9e3e3448`: `bun run check` exited 0; `bun test test/loop-training.test.ts` ran 9 tests, 9 passed, 0 failed, exit 0; `bun test test/knowledge-status-freshness.test.ts test/problems-listing-cache.test.ts test/loop-menu-counts.test.ts test/loop-server.test.ts` passed 25 tests across 4 files, 0 failed, exit 0; `wiki/app` `bun run check` exited 0. Raw tails are in the handback report.

## DONE WHEN
A served product's menu gets the product's current name, kinds, open task count and Problems count on the next poll after the inputs change, including an edit that keeps a file's size and restores its mtime, a template written after its declaration was refused, and a commit on a repository's default branch. `loop.problemsOpen` is the open count of the Problems listing for exactly the answer's inputs: absent while a fill holds the listing back, and present with the Problems page's count on the next poll after the fill. `test/loop-training.test.ts` passes unweakened, with both comparisons of the status answer and `/api/k/problems` naming the Problems page's count for their inputs.
