# wiki-for-people — a wiki a person can read

Adopted 2026-10-24 (the owner's «Да» to the charter summary in conversation
with the coordinator). Follows self-filling, whose released work (0.2.4) the
owner walked on shop the same evening and found unfit to read: «Тебе нужно
пройти каждый раздел и каждую страницу и найти все эти ошибки самому». The
owner set the goal: «Полностью выполнить веху Вики для людей и выпустить
релиз».

After a fill, a person opens the product's wiki and within an hour understands
what the product is and how it is built, and meets none of the defects listed
below. The agent writes for people from the graph; the graph holds only what
the repository shows.

## Outcomes and acceptance

O1: The graph holds only what the repository shows, connected the way the code
is, and every node and edge carries a validation verdict. (madarch-mwhd)
Serves: journeys 4, 6 and 7 of docs/vision.md.
*Check:* on fresh fills of the training product and shop, zero nodes without
evidence, no isolated node outside kinds declared standalone, a verdict on
every node and edge, the provable code problems on the Problems page, and the
answer key's history and temporal items shown.

O2: The agent writes for people from the graph: graph-first tools and prepared
context, documents read by meaning, one question per decision, in-text links
and backlinks, an editorial pass, and the home, domain, scenario, rule and
decision pages each in its own structure. (madarch-ztyq)
Serves: journeys 4, 5 and 6.
*Check:* the answer-key check reports at least 90% of its 175 items fully shown
and none unshown, the 8 expected questions each asked once; every agent page's
journal shows graph work rather than file-by-file reading.

O3: Pages and navigation serve the reader: templates with inheritance and
partials, no empty sections, raw keys or text outside the wiki's language,
members inside their type, a compact glossary, a grouped catalog and menu, the
fill as its own page with a visible Sync, contracts in their standard
renderers, diagrams that show the whole system. (madarch-u3vw)
Serves: journeys 1 and 4.
*Check:* the committed walk over every page of both products reports zero
violations; shots at 1150 and 390 px, light and dark, of every page kind.

O4: The documentation set follows Diátaxis: an administrator guide and a user
guide built from the graph and the documents, each step walked, and the wiki
says plainly what the product lacks (frontend, design, user stories).
(madarch-rckk)
Serves: journeys 4 and 6.
*Check:* a newcomer brings shop up and performs UC-1 from the two guides alone.

O5: Agents read the wiki: every page as Markdown and JSON with a stable schema,
and llms.txt per product. (madarch-4kfc)
Serves: journey 7.
*Check:* the acceptance walk runs only through these addresses.

O6: The milestone's quality is measured by committed checks — a walk of every
page and the answer-key comparison, run on the training product in CI — and by
the owner's reading. (madarch-j6ho)
Serves: every journey above, as their acceptance.
*Check:* both checks in CI; the acceptance record below filled.

### Definition of done

1. Every defect in the list below is re-checked on a fresh fill of shop and of
   the training product, and the acceptance record names each one with its
   evidence (page id, JSON, shot).
2. The committed walk over every page of both products: zero violations of the
   classes empty section, raw key, text outside the wiki's language, node
   without evidence, raw id in text.
3. The committed answer-key check: at least 90% fully, 0 none, the 8 expected
   open questions asked once each.
4. No new defect of these classes is found by the walk.
5. A different model (Codex) reviews the result independently.
6. The release that carries the milestone is published and installed.

### Success criteria

- The owner reads shop for an hour, from the home page down to code, and finds
  no defect of the listed classes.
- From the wiki alone, with a link for each answer: what the product does; how
  checkout goes; where the discount is computed; how to run it locally; who
  calls `/healthz` and how often.

### The defects of 2026-10-24

From the owner's walk of shop on 0.2.4 and the coordinator's walk of all 1 528
pages (scratchpad JSON walk), in the owner's words where he gave them.

Graph:
1. An invented database for checkout, which has none («Как так у БД нет таблиц?»).
2. 11 of 18 routes linked only to their file: no handler, no contract operation, no remote calls.
3. `GET /healthz` served by nothing; Kubernetes probes not extracted («heealthz. Как часто и кем вызывается?»).
4. 377 of 688 symbols isolated: field reads, members of types, constructors, functions passed as values.
5. 49 of 115 file pages empty though what they declare is in the graph.
6. Kafka only a property string; a channel's publisher is a file; no consumers («Почему нет ссылки на kafka?»).
7. Metrics as a list of names: no type, labels, who changes them («кто его изменяет… Где создается»).
8. A logger linked only to its own file.
9. Imports of the standard library and external packages dropped («импорт точно есть»).
10. UC pages: implemented by nothing, no actor or flows («UC очень бедный и без связей»).
11. 4 of 7 glossary terms isolated.
12. Unnumbered non-functional requirements not extracted; missing user stories not stated («Где US? Где функциональные и не функциональные требования?»).
13. Document extraction depends on UC-1/BR-1 numbering («Документы далеко не всегда содержат номера…»).
14. A provable SQL-injection path not on the Problems page (0 problems).
15. Frontend and design not connected, and the wiki silent about it («Еще нет ни слова о дизайне и фронте»).
16. History and time not shown: hotspots, coupling, authorship, moves, the state at a date (answer key).

Agent:
17. Domain pages as code walkthroughs («что из этой страницы можно понять?»).
18. The agent reads files instead of the graph (35 calls: 21 read_file, 0 neighbors) («Почему мы не даем агенту возможность получить сразу нужную функцию?»).
19. 35 questions, about 12 duplicates, two in English, an answered one asked again («Прежде чем принимать вопрос нужно убеждаться, что его еще нет»).
20. «### См. вопрос question:id» headings instead of links («А это что за см. вопрос?»).
21. «См. также» split into an ungrounded statement («Это утверждение без основания откуда взялось?»).
22. Few in-text links, no backlinks («бэклинков по тексту почти нет»).
23. ADR flattened to one paragraph; one template for every document kind («это разве ADR?»).
24. No pass for meaning and consistency («эта вики для людей… смотреть за смыслом текста, согласованностью»).
25. Expected open questions missing (README links, retention contradiction, unverifiable sign-in).
26. No user or administrator guide («Нет руководства пользователя и администратора»).

Pages and navigation:
27. The home page is not an overview («главная не выглядит как мини-обзор продукта»).
28. Kind cards duplicate the menu («они по сути дублируют список слева»).
29. Questions, tasks and problems at the bottom of the menu («Почему самое главное… внизу?»).
30. The glossary too loose («Глоссарий нужно сделать более компактным»).
31. Catalog and menu not grouped by sub-area («кубер, докер… под разделом devops»).
32. A page per field and per facet (407 pages) with empty sections («оно вообще никому не нужно»).
33. Raw keys and JSON in details; English generated text in the Russian wiki.
34. «Импортирует» / «Импортируют» too alike («слова похожи, нужно разделить»).
35. Heading margin inside a quote («отступ большой перед словом Data»); grounds named by anchors; quotes untranslated.
36. Fill progress on the home page, overflowing popover, a still badge («сделать отдельной страницей», «анимацию»).
37. Unwritten pages shown as 18 problems during a fill.
38. An empty «Как агент писал эту страницу» («Это вообще что и о чем?»).
39. No visible Sync («я не вижу кнопки синхронизировать»).
40. «Начать с нуля» keeps the agent's questions and stale closings, and does not say so («я вроде сбросил все, а мой ответ остался»).
41. Contracts without Swagger/Redoc («Где это все?»).
42. Diagrams show a piece of the system (madarch-m38l.15).
43. No Markdown or JSON for agents («почему бы не отдавать страницу в markdown или json?»).

## Exclusions

- Reading frontend code and design files (the next milestone; the training
  repository needs a frontend first). This milestone only says they are absent.
- Synchronisation with a server and federation; editing in the wiki; madarch as
  the tracker.

## Scope decisions

### Carried over and deferred

Carried over from self-filling: madarch-m38l.15 (diagrams), .16 (contracts in
their renderers), .17 (pause and stop), .19 (code problems), and .20 to .25,
filed on 2026-10-24. The merged self-filling tasks are closed through close-out
with their acceptance records; its remaining open tasks are reviewed one by one
and deferred or closed, with the list shown to the owner.

### Finding budget

10 (`findingBudget` in `.shady2k/config.json`); self-filling had 11.

### Target date

None set by the owner. The coordinator's forecast is given with the design.

## Next horizon

Frontend and design in the graph; synchronisation and the server; editing in
the wiki.
