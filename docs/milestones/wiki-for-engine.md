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

O4: madarch's architecture is seen now: madarch's own wiki shows its modules,
entry points (CLI commands, HTTP routes, MCP tools), stores and database
tables, glossary terms, and who imports, calls, reads and writes what. Where a
plugin does not fill a kind yet, the coordinator states its entities through
the operations of O1 and O5, as an author of its own, and a plugin's later fill
replaces them.
Serves: journeys 1, 4 and 7.
*Check:* every module, entry point and database table of madarch has its page;
each value names its author, a plugin or the coordinator.
*Signal:* the owner answers from madarch's wiki alone which modules read which
tables.

O5: MCP for agents: workers and the coordinator read the graph and write
entities through `madarch mcp`.
Serves: journey 7.
*Check:* a worker answers a question about madarch's code through `madarch mcp`
and its journal counts the questions the graph answered; an entity written
through MCP appears in the wiki with its author.
*Signal:* a worker's brief names `madarch mcp` and the worker uses it.

O6: The Files section serves a reader as the owner's reference screens do: a
map of the repository with area and colour switches, a file table with a
filter, and a file page with its header (main authors, hotspot, figures) and
the History and Co-change tabs (carried from the first plan; the owner: «Нам же
нужен шаблон страницы файлов»).
Serves: journey 4.
*Check:* side by side with the owner's reference screens, each switch and the
filter exercised; the figures of three files checked against git; every link on
the Files pages opens its page.
*Signal:* the owner finds a hotspot and its authors from the map in a minute.

## Exclusions

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

### Finding budget

None. The owner removed the budget on 2026-11-13, after the demo walk turned up more findings than 15: «Да какой нафиг бюджет. У нас продукта по сути нет.» (`findingBudget` is null in `.shady2k/config.json`; every finding is filed into the milestone as it is found.) Earlier: 15, as in wiki-for-people.

### Target date

None set from outside the project.

## Next horizon

- The move from br, and then working in madarch instead of br.
- The public read-only wiki of madarch with a version selector, opened by
  `madarch help`.
- Switching a failing plugin off; the sandbox; the agent's meaning check.
- Plugins that read external systems.
