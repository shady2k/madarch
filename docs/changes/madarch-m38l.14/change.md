# Answers lead to scoped tasks and graph-computed refresh impact

Change: madarch-m38l.14
Base: 05af1efa
Tasks: madarch-m38l.14
Kind: behavior

## Intent
A reader's answer can resolve a question into a confirmed, scoped task, and can see exactly which wiki pages and statements a refresh would change before choosing to run it. Planned changes are visible only on their named document sections or code scope and on statements that rely on them. The generated training repository must support correcting the retention documentation based on the answer «Прав код, документ устарел».

## Out of scope
- Starting a real agent automatically; a person still confirms and presses to run.
- Changes to the writer/agent protocol owned by madarch-m38l.13.
- Manifest-upgrade mechanisms, index refusal and product settings owned by madarch-m38l.11.
- Reader shell changes owned by madarch-m38l.12 and diagrams owned by madarch-m38l.15.

## Changes to requirements
- product-wiki/discussions (replaced): preserve existing discussion behavior and add task answers, confirmation, scoped planned-change badges, graph-derived impact and explicit refresh action. Complete proposed text and scenarios are in `capabilities/product-wiki.md`.

## Preserved contracts
None.

## Coverage
- product-wiki/discussions: test, browser-walk

## Where it is seen

Kind: screen
Place: the training repository's wiki question page, affected page sections and refresh preview
Mockup: docs/prototypes/madarch-m38l.7/en-02-question-open.png

1. A reader answers the retention question with «Прав код, документ устарел», reviews a prefilled scoped task for the two README sections and confirms it.
2. Planned-change badges appear only on those sections and on statements relying on them.
3. The graph-derived action preview lists the impacted pages and statements; the user may run the scripted agent on exactly those pages.
4. A commit naming the task and touching its scope closes it.

## Blocking questions
None.

## Design and decisions
The task is persisted as a `task` kind in the product repository and connected to the question, answer and scope. Scope is an explicit section, line range, symbol or statement; it is not widened silently to a whole file. Impact starts with the task's grounds, reads dependent statements through `statementsRelyingOn`, and follows pages linked to those statements or entities. The engine, not the scripted agent, computes the list. The same list is shown before a run and given as the run's exact write scope. Task badges are derived from indexed scope and task status. A code commit closes a task only when it names the task and changes the task's scope; manual closure remains available.

## Acceptance evidence
Run on the SkyPilot pool (the AVX2 recipe, `MADARCH_SKY_MEMORY=8`; the wrapper's own launch was refused at first and the same launch was queued once with `--retry-until-up`, starting when a slot freed) and in CI on the pull request's head, with fixtures only: the generated training repository and the wiki app built there.
- The acceptance walk on the training repository, `bun test test/loop-training.test.ts` on the pod (9 cases, 64.7 s of tests, exit 0): the retention question answered with «Прав код, документ устарел» proposes a task scoped to `README.md#what-it-does` and `services/orders/README.md#orders-service` — the sections, not their files — whose impact through the graph names every statement standing on them, on the domain page and on the question page the agent wrote; confirming it writes `docs/tasks/<slug>.md` committed as the reader and marks exactly those sections and those statements («основание будет изменено») while the payments page and the other documents stay unmarked; «Поправить страницы сейчас» runs the scripted ACP agent over exactly `docs/domains/ordering.md` (the run's plan holds one page with the task as its reason, one unit ran, the product and payments pages stayed byte-identical); and a commit that names the task and changes the section's own lines closes it, while a commit naming another task, a commit naming the task that changes only code, and a commit naming the task that changes another section of the same file do not. Closing by hand is refused once the task is closed.
- `bun test test/loop-tasks.test.ts` (5 cases over HTTP, no fill, no agent): the proposal's scope and title for either choice, its refusals (an unanswered question, an unknown choice, an existing task, an empty scope, a scope the wiki cannot read back), the written file and its front matter, the planned mark on the document and the absence of one on a document no task names, the closure by a commit of the code repository's default branch with the repository name, the commit and its date, and the hand close with `closed-by: person`.
- The wiki app's own checks pass in CI (`bun run check`, `bun test`, `bun run build` in `wiki/app`).
- Screenshots, 40 of them, in English and Russian, light and dark, at 1150 px and 390 px, rendered by headless Chromium over the server and the built app (`bun scripts/knowledge-shots.ts --only tasks --out /tmp/madarch-shots-final`, on the pod, fetched): the answer proposing the task, the badge on the README section, the badge on the dependent statement, the task card with «Поправить страницы сейчас», and the «Задачи» page (`/home/dev/task-shots-final/<lang>-<scheme>-<width>-k0N-<state>.png`, listed in full in the worker's report). [REVIEW RESULT]
- A read-only Codex review of the change found 19 points; the ones that held were fixed in the two commits after it: the impact and the badges followed the answer's grounds instead of the confirmed scope, a symbol's key stayed prefixed and a statement's scope named no file, a section closed on any change of its file, a deletion counted nowhere, a task id matched by substring, a task a commit closed could be closed by hand and run again, a scope the wiki could not read back was written into the file, the product's own repository closed no task for the badges, a statement merely mentioned was marked as a standing ground, and the run could finish without writing a page the preview showed. The two that remain are recorded in the worker's report as limits.

## DONE WHEN
On the generated training repository, the answer «Прав код, документ устарел» yields a prefilled task scoped to the two README sections; confirming it marks only those sections and their relying statements as planned; the graph-computed «Поправить страницы сейчас» preview names exactly impacted pages and statements and the scripted agent rewrites only those; a commit naming the task and touching its scope closes it; rendered English and Russian shots have been inspected.
