# Prepare: the agents visible, the pair and the cap the press sends, and words only for what a person needs

Change: madarch-64o5.90
Base: 8b3c73cb7bfa96b18c8c6f98e7f3ee2d6590d65c
Tasks: madarch-64o5.90
Kind: no-behavior

## Intent
The owner's walk of 0.3.0 on the fill's prepare page (/p/prepare?kinds=…):

1. «Почему здесь не отображается заполнение с агентом?» — with no saved agent the page ticked «Только плагины» itself and
   hid the installed, signed-in agents. Every offered agent now stands beside «Только плагины» as one radio group, the
   product's saved agent (else plugins-only) stands, and an agent that cannot run is shown with what is missing.
2. «Я хочу другую модель выбрать, почему здесь нет возможности выбрать?» — the model was plain text. The chosen agent's
   model and reasoning level are selects beside the cap, defaulting to the product's saved pair, sent with this run;
   «Сохранить по умолчанию» saves the agent with the pair. The choices route answers for a picked-but-unsaved agent.
3. «лимит токена, наверное, какой-то дефолтный должен быть» — the product holds a default token cap (200 000 at first),
   editable in the product settings; the prepare page offers it, and an empty field runs under it instead of refusing.
4. «И вот эта фраза зачем? "Одно нажатие запускает заполнение. Второго вопроса нет."» — the press carries the run's
   estimate instead («≈ N мин · до N токенов», the time alone for plugins-only), and no sentence narrates the page.
5. The wall of text naming unfilled fields became one counted line that opens into a row per kind.
6. The agent cards said the adapter path and version; they now say «Вход выполнен», «Нет входа — войдите в <агент>» or
   «Не установлен — установить в настройках продукта» (a link), and the path and version stay on the settings page.
7. Codex's review of #319: Run waited neither for the product settings nor for the chosen agent's choices, so a press
   could send the adapter's defaults or another agent's pair. Run is disabled until both have answered, choices are used
   only when the answer names the selected agent, and «Сохранить по умолчанию» waits the same way.

The behaviour the accepted requirements describe does not change: the fill plan, the agent it runs, the cap and the
pages are the same mechanism; what changes is what the page offers and what the press names.

## Out of scope
The wider layout of the catalogue and the fill panel (madarch-64o5.56, madarch-64o5.34), and madarch-64o5.111 (the
machine settings page carrying adapter paths and versions).

## Rationale
Seven findings of the same page: a person could not see the agents, choose a model, or read a default cap, and the page
told them how to use it instead of what the run would take. Two of them could send a pair the person did not choose.

## Changes to requirements
None.

## Preserved contracts
- product-wiki/acp-agent: the fill still runs one agent the product saved or the press named, over ACP, under the cap the press sends.
- product-wiki/internationalization: every new string exists in en and ru.

## Coverage
- product-wiki/acp-agent: test
- product-wiki/internationalization: test

## Where it is seen
Kind: screen
Place: /p/prepare?kinds=<kind,…> of a product, opened from the catalogue's selection
1. «Кто заполнит» lists every offered agent and «Только плагины»; the saved agent, else plugins-only, is selected.
2. Choosing an agent shows its model, its reasoning level and the token cap (the product's default), with the run's estimate beside the press.
3. «Только плагины» shows the unfilled fields as one counted line that opens into a row per kind.
4. A press sends the agent, the pair and the cap the page shows.
