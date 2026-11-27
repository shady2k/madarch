# The run page counts entities, not the engine's work units

Change: madarch-64o5.106
Base: f8553165a01b81a01aaa41e54ada99c1269454d0
Tasks: madarch-64o5.106
Kind: no-behavior

## Intent

The owner's first agent fill («Домены», Codex, run `fill-20261115T100215847Z`) spent 70 000 tokens and returned
`{"vertices":[],"edges":[],"end":{"state":"complete"}}`: nothing was written. The run page read «Опубликовано 1 из 1
единиц · Завершён» beside «Записано фактов: 0», so the owner read it as a page created that he could not find («оно
отработало, написало, что одну страницу создало, но я здесь ничего не вижу»).

The run's page and the runs list now count entities, never the engine's work units. A finished run that created nothing
says so and states the cause the producer gave, or — when the agent stated none — that it opened no file and made no tool
call. A run that wrote states what it created and changed, per kind and in the reader's words.

## Out of scope

- Listing each written entity as a link to its page, and rolling a run's own opinions back from it (the rest of the
  owner's note on madarch-64o5.106, a later change).
- The engine's words on the logs page and the fill page, which name their own work.

## Rationale

A unit is the engine's own work: one unit per kind and scope, published whether or not it wrote a fact. Counting
publications therefore reports the engine's progress as the reader's result. The graph already keeps what answers the
reader's question: each unit's producer answer (`system.unit.outcome`, `produced`, `reason`), and every assertion a
unit wrote linked to that unit (`system.assertion-unit`). The run's own detail now reads both, so the page states
created and changed entities from durable state and the read costs the work the run did, never the size of the store.

## Preserved contracts

- product-wiki/pages: the run's page is still one read of the run's durable state, worded for the reader, with no engine trace, machine path or internal id (test).
- fill-orchestrator/publish: a unit's publication is still the run's durable result; the page names the entities that publication wrote instead of the publication itself (test).

## Coverage

- product-wiki/pages: test
- fill-orchestrator/publish: test

## Where it is seen

Kind: screen
Place: the run's own page and the runs list, reached from the fill's history
Mockup: docs/changes/madarch-64o5.106/run-result.html

1. A person opens a finished run whose agent returned no entity: the page's title reads «Ничего не создано: агент не
   нашёл ни одной сущности», the kind's group repeats it with «Готово», and the cause stands under it — the agent's own
   reason, or that it opened no file and made no tool call. «Опубликовано» and «единиц» appear nowhere.
2. A deterministic plugin that found no applicable place reads «Ничего не создано: плагин не нашёл ни одной сущности»
   with the reason it recorded.
3. A run that wrote entities reads «Домены: создано 3, изменено 1» per kind, and the title counts the entities of all
   kinds with the Russian plural forms.
4. The runs list states a finished run that wrote nothing as «Ничего не создано», and one that wrote as the facts it
   wrote, never as a count of publications.

## Blocking questions

None.
