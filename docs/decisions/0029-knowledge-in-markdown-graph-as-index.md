# 0029. The wiki is a Markdown engine: what cannot be rebuilt is Markdown in the product repository, and the graph indexes it with the code facts

Status: accepted
Date: 2026-10-22

Amends 0026: its live pages rendered from graph nodes without a file are replaced by templates, as
the Decision says. Amends 0028: agent claims no longer live only in the graph. Builds on 0021 (the
product repository contract) and 0023 (people's writing is in git, derived indexes are rebuilt).

## Context and problem

On 2026-10-21 the self-filled wiki failed. One cause was 0026's live pages: about 39 000 of them,
one per graph node, of unclear origin and little value. Today's rebuild gave madarch a temporal
graph (0028) and five deterministic extractors. That raised the question of what a page is, and
where its words live.

The owner's description of what madarch is for, 2026-10-22, in his words:
- «Я продуктовый инженер. У меня есть какой-то готовый репозиторий. Я скачиваю себе этот Madarch,
  устанавливаю. Запускаю вики… на первой странице… будет просто инструкция, плейсхолдер, что
  делать… После того, как мы запустили процесс извлечения информации, вики у меня прямо на глазах
  онлайн начинает заполняться.»
- «Главная страница должна фактически описывать что это за продукт, его базовую архитектуру… общие
  концепции… человек… погружаться должен медленно от общего к частному.»
- «Каждое слово, которое отображается в вики, оно опирается на какой-то факт… Оно не может быть
  абстрактным в вакууме.»
- «…перейти на описание домена оплата… какие сервисы это реализуют, какие файлы при этом
  участвуют, какие методы… в конце концов он спускается до уровня кода… кто его вызывает, кто его
  реализует, какие зависимости у него есть… бесконечная вики… с диаграммами, с описаниями».
- «Наша вики — это движок работы с md. В репозитории продукта лежат манифесты, которые содержат
  список сущностей, связи, атрибуты. Шаблоны md должны быть там.»
- «Граф — это и есть сами данные.»
- «Граф не должен быть связан с шаблоном… шаблон — это способ отображения данных из графа.»
- On keeping the graph: «Ты сначала позиционировал граф как кэш. Получается он нифига не кеш.»
  He agreed («Да») to the split below.

## Decision

**Reader levels.** A reader goes from the general to the particular:
1. the product: what it is, for whom, its capabilities and architecture, on the home page;
2. domains and capabilities, such as payment or ordering: how they work, which services take part,
   and their scenarios with diagrams;
3. components (services, modules): purpose, interfaces, data, dependencies and callers;
4. code (files, functions): highlighted source, callers, implementations and dependencies.

Every mention of an entity is a link, so the wiki is an endless web of links down to the code. An
empty graph shows what to do next. A fill updates the open pages as it goes.

**Every statement is grounded.** The unit is one statement, usually one sentence. Each statement
carries links to what it is based on: a use case, a requirement, a document section, a file or a
function. A paragraph is a sequence of statements. Entities named inside a statement are links in
the text. A statement with nothing behind it is not shown as fact.

**Where data lives, by whether it can be rebuilt.**
- Facts read from code and history can be rebuilt deterministically, in about a minute on the
  training repository. They live only in the graph, as a rebuildable index (0028).
- What agents write cannot be rebuilt cheaply or identically: the product description, domains,
  statements and their grounding. It lives in the product repository as Markdown, one file per
  entity, with its identity and links in the file and its statements' grounding inline.
- What people write cannot be rebuilt at all: edits, acceptance, answers and their own documents.
  It also lives in the product repository as Markdown, so git shows each edit and review works.
- The graph indexes the Markdown together with the code facts. A rebuild reads code and Markdown
  and loses nothing that was written. No database dump is kept in git.

**Manifests and templates live in the product repository.**
- The manifests are the schema: entity kinds, their attributes and their relations.
- A template is a way to show graph data. The graph knows nothing of templates. A template says
  which data it shows and how. One entity can appear through several templates, and one template
  can gather several kinds.
- madarch ships a starter set. After that, the manifests and templates are the product's data.
- The engine reads the manifests, the graph, the Markdown and the templates, renders pages and
  diagrams, and holds nothing product-specific.
- Upper-level pages (product, domains, scenarios) are mostly the product's Markdown. Lower-level
  pages (component, file, function, table) are templates over graph facts, with no file behind
  them.

## Consequences

- 0026's per-node live pages without a template are retired. 0026's graph-first fill, bounded
  agent units and reading only through the graph stand.
- 0028's "What a rebuild keeps" changes: agent claims are written to the product repository's
  Markdown and survive a rebuild. 0028's store design stands.
- The product repository contract (0021) gains entity manifests with attributes and relations, and
  page templates. The template language, meaning how a template names the data it shows, is
  decided on one or two real pages.
- The agent stage writes Markdown files in the product repository, each statement grounded. Its
  checks verify that every statement's links resolve in the graph.
- The answer key of the training repository judges the pages a reader reaches, at every level.

## Open

- The template language.
- How a person's edit to an agent-written statement is kept across the agent's next run (merge,
  or agent never overwrites a human-edited statement).
