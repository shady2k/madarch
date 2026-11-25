# wiki-for-engine — madarch is developed through madarch

Adopted 2026-11-10 (the owner's «Да» to the charter summary in conversation with
the coordinator). Follows wiki-for-people, closed the same day («Да, веху
закрываем.») after the owner found second surfaces still reading around the
graph. The owner set the goal:

«Я хочу от тебя чтобы мы с тобой подготовили фундамент, базу, архитектуру
решения. И уже начали с тобой заполнять вики, чтобы я мог видеть, что у нас
происходит, какие у нас таблицы, какая у нас архитектура, какие модули, с кем
взаимодействуют и так далее. Понимаешь? То есть я хочу использовать нашу вики
для разработки нашего движка.»

Re-planned 2026-11-11, after a day in which work ran on all four first outcomes
at once and none was accepted. The owner restated the goal:

«Я хотел бы наш продукт собственный помогал нам разрабатывать наш собственный
продукт… я сначала хотел сделать архитектуру у нас движок у нас есть каталог
сущностей каждая сущность самодостаточная она по факту работает может работать
без всякого кода до за счет того что есть один плагин агентского заполнения вот
я это хочу и я хочу миграцию с моего трекера текущего»

and named the work: «проверяем каталог сущностей и crud операции над ними;
делаем агентский плагин заполнения; делаем возможность начать заполнения по
выбранным сущностям и разделам; если что-то не получается, ты заполняешь граф
за плагин, чтобы я уже сейчас мог видеть архитектуру; делаем mcp, чтобы агенты
могли использовать граф». Work runs in parallel; the coordinator writes no code
and reports progress against this charter, speed included, and every deviation
(«Именно твоей задачей является отслеживание, что мы движемся к цели и
подсвечивать мне отклонения, в том числе по скорости»). The owner approved the
summary with one change: «песочницу как раз можно отложить» — the agent part
runs without the sandbox in this milestone. The estimates are counted in hours
(«Никаких дней. Пересмотри сроки. Там уже много что выполнено.»).

The engine holds no entities: every kind is a declaration in the product's
catalogue, with its description and fields, and a kind with no plugin of its
own is filled by the one agent-fill plugin. The wiki, its API and MCP read only
the graph (decision 0034, decision 0035 items 16-33).

Trimmed 2026-11-25 (the owner's «Да, 1А, 2А.» in ALX-1694, resting on his order
of the same day: «Я хочу, чтобы работа шла постепенно: мы сейчас делаем сам
граф, саму основу — фундамент. После этого мы начинаем вместе заполнять вики по
частям, по каждой сущности, и по мере того, как мы её заполняем, этот же граф
используется для разработки. Мы здесь преследуем две цели: 1. Дать агентам
инструменты, чтобы можно было анализировать код и планировать изменения через
граф. 2. Показать архитектуру мне — и тогда дальнейшее развитие пойдёт гораздо
легче.»). After foundation 0039 and `.148` land, this milestone ships only the
minimal O1–O5 cycle (10 launch blockers, estimated 3–5 calendar days):
entity-by-entity filling, showing madarch's core architecture in the wiki, and
agent code analysis/planning through `madarch mcp`. O6 (the Files section
treemap and reference screens) moves to the stage immediately after the O1–O5
cycle starts (choice 1A), non-blocking polish and next-turn features move to
`deferred`, and the finding intake filter plus a 15-finding forward guard are
restored (choice 2A).

## Outcomes and acceptance

O1: The catalogue and operations on entities: the kinds are declarations in the
product's manifest and their tables are built from them alone; a person or an
agent creates, edits and deletes an entity of any kind the manifest lets people
author, through the wiki, the `madarch` CLI and MCP, stored in the database and
journalled with its author.
Serves: journeys 4, 6 and 7 of docs/vision.md.
*Check:* on a fixture product, adding a kind with fields to the manifest
creates its table and removing it removes the table; an entity is created,
edited and deleted through each of the three ways; an invalid value is refused
naming the field and the reason; each change is in the journal with its author.
*Signal:* the owner creates a task of madarch's own in its wiki and edits it.

O2: The agent-fill plugin: a kind declared in the catalogue only by its
description is filled by one general agent plugin, and every model call is
metered: model, tokens and cost per run and per kind, on the kind's page. The
agent part runs without the sandbox in this milestone.
Serves: journey 6.
*Check:* on a fixture product, a kind with a description and no plugin of its
own is filled by a real agent run within the cost cap the owner names, and its
page shows the model, the tokens and the cost.
*Signal:* the owner reads what a fill of a kind cost from its page.

O3: A fill of a chosen part: a person starts a fill of the kinds or the sections
they select, from the catalogue page or the CLI; only those and their stale
dependencies run, and the dependency graph page shows the order and progress.
Serves: journey 6.
*Check:* selecting one section on the catalogue page and pressing Fill runs only
that section's kinds and what they need; the dependency graph page shows each
kind's state while the fill runs and after it; the CLI does the same.
*Signal:* the owner fills one section and sees only it change.

O4: madarch's architecture is seen now: madarch's own wiki shows its core
architecture layer — modules, entry points (CLI commands, HTTP routes, MCP
tools), stores and database tables, and who imports, calls, reads and writes
what — filled incrementally entity by entity alongside the owner (remaining
catalogue kinds are filled gradually during development). Where a plugin does
not fill a kind yet, the coordinator states its entities through the operations
of O1 and O5, as an author of its own, and a plugin's later fill replaces them.
Serves: journeys 1, 4 and 7.
*Check:* the first incremental pass covers madarch's core architecture layer
(modules, entry points, database tables and their relations); each value names
its author, a plugin or the coordinator.
*Signal:* the owner answers from madarch's wiki alone which modules read which
tables.

O5: MCP for agents: workers and the coordinator read the graph and write
entities through `madarch mcp` to analyse code and plan changes.
Serves: journey 7.
*Check:* a worker answers a question about madarch's code through `madarch mcp`
and its journal counts the questions the graph answered; an entity written
through MCP appears in the wiki with its author.
*Signal:* a worker's brief names `madarch mcp` and the worker uses it.

## Exclusions

- O6 — the full Files section reference screens (interactive treemap with area
  and colour switches, filtered table, and History/Co-change tabs;
  `madarch-j9ao*` and `madarch-u3vw.17`): moved to the stage immediately after
  the O1–O5 cycle starts (owner's 2026-11-25 choice 1A, ALX-1694); basic file,
  folder, commit and code pages are already on `main`.
- Non-blocking work deferred in the 2026-11-25 cut (ALX-1694): strict UI-kit
  linter and deduplication (`madarch-64o5.127`, `.130`), full i18n and
  automatic content translation (`madarch-64o5.103`, `.108`, `madarch-stm0.5`),
  role-based access control (`madarch-64o5.115`), full-text git blob search
  (`madarch-64o5.100`), refactoring 0040 (`madarch-ninm*`), storage read cache
  and secondary performance tuning, extended repository dashboard
  (`madarch-64o5.70`), CLI alias cleanup, and non-blocking UI polish and
  findings.

- The move from br into madarch's database (the owner, 2026-11-11: «Убери
  переезд из br в раздел позже»): next horizon, by the import rules agreed on
  2026-11-08 (docs/vision/tracker-decisions-2026-11-08.md, Q1.17).
- The sandbox for a plugin's agent part, and plugins on NixOS in the sandbox
  (madarch-64o5.1): «песочницу как раз можно отложить».
- Switching a failing plugin off (madarch-8bdc.2.22): needed, after this
  milestone («сейчас, прямо сейчас, конечно, мы можем это отложить, но вообще
  это обязательно нужно»).
- Mutation survivors (madarch-8bdc.2.19) and the agent's check of the
  documents' meaning (madarch-stm0.8).
- The public read-only wiki of madarch, which is also its help and demo
  (madarch-m5i7); until it exists there is no `madarch help` and no demo.
- Plugins that read external systems (madarch-pmjm).
- Updating by commit on every branch in the background, and people changing the
  wiki through the agent (madarch-8bdc.6, madarch-8bdc.7).

## Scope decisions

### Carried over

From wiki-for-people: the open tasks of stage madarch-8bdc.2 (the fill by kinds
8bdc.2.16, the CLI message 8bdc.2.18, mutation survivors 8bdc.2.19, the
first-parent count 8bdc.2.20, the manifest check 8bdc.2.21, the plugin state
8bdc.2.22, the glossary through the plugin path 8bdc.2.23), the read path
reading only the graph (madarch-hsqs), the /k prefix (madarch-q6mx), the missing
entity page (madarch-moo8) and the empty language column (madarch-slrs).

Closed as obsolete, by the owner's word «Устаревшее нужно закрыть, а не
откладывать»: the features and stages of wiki-for-people the new outcomes
replace (madarch-mwhd, madarch-ztyq, madarch-u3vw, madarch-rckk, madarch-4kfc,
madarch-j6ho, madarch-8bdc and its stages 8bdc.3 and 8bdc.5) and their tasks
that the plugin design retires; their merged tasks are closed as delivered,
without the old stage acceptance.

Deferred, still wanted later: madarch-8bdc.6 (update by commit on every branch),
madarch-8bdc.7 (changes through the agent), the reference graphs 8bdc.2.6 and
8bdc.2.7, keyboard search (madarch-o0d), the catalogue's contents and filter
(u3vw.11), the stale status cache (u3vw.8), Mermaid in Markdown (u3vw.18), the
writing features ztyq.7 to ztyq.9, pausing the writer (m38l.17), and two CLI and
release bugs (madarch-v2vt, madarch-v4qi).

### 2026-11-25 cut (ALX-1694)

After auditing the 199 active `wiki-for-engine` items against `origin/main` and
foundation stack 0039, the owner confirmed the minimal O1–O5 cut («Да, 1А, 2А.»,
ALX-1694):

- **Closed (89):** 86 already-landed items (64 `madarch-64o5.*` including
  `madarch-64o5.146` `io-spans` with 0 violations and `madarch-64o5.11`, 15 old
  `madarch-8bdc.*`, and 7 O1–O4 items) plus 3 superseded items (`64o5.40`,
  `64o5.57`, `8bdc.2.16`).
- **Left untouched in flight (18):** the current foundation stack 0039 and
  `.148` (`ALX-12` / `ALX-1087`, with `madarch-x9a7.5` already closed).
- **Kept active for launch (16):** the 6 O1–O5 epics (`madarch-47vw`,
  `madarch-64o5`, `madarch-huq3`, `madarch-q3ak`, `madarch-stm0`,
  `madarch-stm0.6`) and 10 launch blockers (`madarch-64o5.52`, `.72`, `.89`,
  `.106`, `.123`, `.151`, `.152`, `.158`, `madarch-7okm`, `madarch-vmx9`).
- **Deferred (76):** O6 Files section (7 items `madarch-j9ao*`, choice 1A) and
  69 non-blocking items (UI-kit linter, i18n/translation, RBAC, full-text git
  blobs, 0040 refactoring, cache/perf, UI/file polish including
  `madarch-u3vw.17`, CLI aliases, sandbox/CI tails and non-blocking findings).

### Finding budget

Restored on 2026-11-25 (owner's choice 2A, ALX-1694): only real blockers of the
O1–O5 launch cycle (breaking entity-by-entity filling, showing madarch's
architecture, or `madarch mcp`) enter `wiki-for-engine`; non-blocking findings
go to backlog / `deferred`.

Because `.shady2k/checks/check.mjs` counts non-deferred findings cumulatively
across the milestone (41 already closed + 12 still open as of 2026-11-25 = 53
recorded during the unlimited period since 2026-11-13), `.shady2k/config.json`
sets `findingBudget: 68` (53 already recorded + 15 new-finding guard going
forward) so the pre-commit gate stays green while enforcing the 15-finding cap
on new intake. Earlier: 15 (2026-11-10), then `null` (2026-11-13, «Да какой
нафиг бюджет. У нас продукта по сути нет.»).

### Target date

None set from outside the project.

## Next horizon

- O6: the Files section reference screens (interactive treemap with area and
  colour switches, filtered table, and file History/Co-change tabs;
  `madarch-j9ao*` and `madarch-u3vw.17`) — first stage after the O1–O5 cycle
  starts.
- Deferred UI-kit linter/deduplication, full i18n and content translation,
  role-based access control (`Person/Role/Permission`), full-text git blob
  search, refactoring 0040, and non-blocking UI polish.
- The move from br, and then working in madarch instead of br.
- The public read-only wiki of madarch with a version selector, opened by
  `madarch help`.
- Switching a failing plugin off; the sandbox; the agent's meaning check.
- Plugins that read external systems.
