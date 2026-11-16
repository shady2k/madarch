# Every log in one place, and what each agent was given and returned

Change: madarch-64o5.88
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: madarch-64o5.88
Kind: behavior

## Intent
The owner, on the run page's journal: «Журнал и компонент для журнала в работе?» — the run page keeps a short human
journal and there is one page and one component for every log madarch writes. After his first agent fill wrote nothing
and nobody could see from madarch what the agent was given or what it returned («вообще увидеть что мы передали
агенту … как мы с тобой будем отлаживать, что мы передали агенту, что он вернул, трейсы, это где все?»), madarch
records every agent unit's whole exchange itself, with the run: the task, every tool call with its arguments and its
result, the final answer and the tokens per step. The run page gives each agent unit «Подробно» — what it was given,
what it did step by step, what it returned, its tokens, and the record as raw JSON.

The logs of the server, of each fill, of each plugin's standard error, of each agent unit's exchange, of the store's
PostgreSQL server and of a run's spans are read through one route with paging, filters and a live tail, and drawn by one
kit log viewer: one time per row in the reader's clock, levels as shapes, the engine's events worded from codes, text
madarch did not write quoted, the kit's own controls for the filters, and a copy of a row or a selection. The run page's
journal states every failure with the failure's own words, its file and line, the next action and a link to the row in
the logs.

## Out of scope
- The file's own text and a contract's definition rendering: PR #325 (madarch-u3vw.16) owns them.
- The kit's membership: the owner decides whether the one-choice menu, the moment field and the log viewer stay in
  `components/ui`; madarch-64o5.130 merges duplicates.
- A new table or data file outside the graph: the two records the run keeps — one file per agent unit's exchange and
  one per plugin run's standard error, in folders beside the run's trace — were escalated to the owner, and nothing else
  is added.
- A real agent or model: every test runs a scripted ACP peer.

## Preserved contracts
- product-wiki/acp-agent: the client that drives an agent over the protocol is unchanged; the record is written beside it.
- server/serves-wiki: a server given a product folder still serves its wiki, and the logs route is one more command read.

## Coverage
- product-wiki/logs: static, test
- product-wiki/acp-agent: test
- server/serves-wiki: test

## Where it is seen
Kind: screen
Place: the run page of a fill (`/p/run?run=fill-1700000000000`) and the Logs page (`/p/logs`) of the product's wiki
Mockup: docs/changes/madarch-64o5.88/mockups/logs-1440-light.png
1. On a product filled with a scripted agent, open the run page: the «Что получил и вернул агент» card holds the unit's «Подробно» — the prompt as sent, the files it opened, its steps, its answer, its tokens and «сырой JSON»; the shots `run-1440-light.png`, `run-390-dark.png` and their pairs show it.
2. Open the Logs page filtered to the run (`/p/logs?run=fill-1700000000000`): one time per row in the reader's clock («17:54:53,565»), the level as a shape, engine rows worded in Russian, outside text quoted; the shots `logs-1440-light.png` and its pairs show it at 1440 and 390, light and dark.
3. Choose a source, a level and a run from the kit's menus, set a window of time in the moment field, type a text in the search, pause the live tail and copy a row.
4. On a run that failed, the journal names the retry once with its count, states the plugin's own failure with its file and line, the next action and «Открыть в журналах»; the link opens the Logs page filtered to that row, where the error's whole text stands; the shots `run-failed-1440-light.png` and `logs-failed-1440-light.png` and their pairs show it.
5. The kit page draws the log viewer in its states — default, error with its stack and context, empty, loading and live — with the kit's menu and moment field beside it.
