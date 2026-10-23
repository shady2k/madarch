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
To be added after the generated training repository walk, focused SkyPilot tests, rendered English and Russian shots, read-only Codex review and CI on the PR head.

## DONE WHEN
On the generated training repository, the answer «Прав код, документ устарел» yields a prefilled task scoped to the two README sections; confirming it marks only those sections and their relying statements as planned; the graph-computed «Поправить страницы сейчас» preview names exactly impacted pages and statements and the scripted agent rewrites only those; a commit naming the task and touching its scope closes it; rendered English and Russian shots have been inspected.
