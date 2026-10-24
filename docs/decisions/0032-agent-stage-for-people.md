# 0032. The agent stage writes for people: a graph of units over prepared context, anomaly-driven validation, documents read by meaning, Liquid templates

Status: accepted
Date: 2026-10-24

Amends 0029: templates may hold presentation logic (layouts, partials, conditions) through
LiquidJS; the writer is no longer product-then-domains. Builds on 0026 (bounded units reading only
the graph), 0027 (the fill orchestrator), 0028 (the temporal store) and 0029 (Markdown is what
cannot be rebuilt). Milestone wiki-for-people (docs/milestones/wiki-for-people.md), task
madarch-ztyq.1.

## Context and problem

On 2026-10-24 the owner walked shop on 0.2.4 and found the wiki unfit to read; the coordinator's
walk of all 1 528 pages and the comparison with the training repository's answer key confirmed it:
about 27% of the key's 175 items fully shown, 62% partly, 11% not at all. The causes are structural:

- The writer runs two kinds of unit, the product page and the domain pages (`runWriter()` in
  `src/writer/run.ts`; `UnitSpec`; `fsSink()` allows product, domain and question files). Use cases,
  rules and decisions are never enriched, so a UC page says «implemented by: nothing».
- The agent navigates the graph like a file system. The payments domain unit made 35 calls: 21
  `read_file` of whole files, 12 `find_nodes` by path text, no `get_node` and no `neighbors`. It
  paraphrased code, so domain pages read as code walkthroughs; the shared prompt (`fixedPart()` in
  `prompts.ts`) even asks for timeouts and retries on every page.
- Documents are read by numbering (`sectionsOf()`/`kindOfSection()` in `doc-entities.ts`); an
  unnumbered «Qualities» section yields nothing.
- Question deduplication is word overlap (`askQuestion()`: same type, `subjectOf()` Jaccard ≥ 0.5);
  shop got 35 questions, about 12 of them duplicates.
- Nothing checks meaning: an invented database, routes without handlers and 377 isolated symbols
  passed every check, because the checks verify that citations resolve, not that facts are true.
- Templates are substitution plus directives, with no inheritance or conditions; every document kind
  shares one template, and empty sections cannot be hidden.

The owner's words, 2026-10-24:
- «В первую очередь эта вики для людей, поэтому нужно смотреть за смыслом текста, согласованностью.
  Для агентов есть md, json, граф, mcp.»
- «агент должен просмотреть каждую вершину графа и его связи и провалидировать. Тут еще можно
  подумать, чтобы использовать что-то типа jev», and later: «можно детерминировано проверять все
  вершины. Но если нет связей, то это повод дать узел агенту на посмотреть. Или например есть импорт,
  но его никто не вызывает, не читает, не реализует», «БД без таблиц и т.п.»
- «Прежде чем принимать вопрос нужно убеждаться, что его еще нет.»
- «Документы далеко не всегда содержат номера в стандартном виде типа UC-1.»
- «Почему мы не даем агенту возможность получить сразу нужную функцию?», «Посмотри на работу
  агента, может быть ему какого-нибудь инструмента не хватает.»
- «для каждой сущности может быть либо базовая страница, либо определенный шаблон. Можно
  шаблонизатор какой-нибудь использовать, чтобы и наследование было и можно было бы страницу из
  частей собрать.»
- «Ты же представляешь как пишется и выглядит техническая документация? Нет руководства
  пользователя и администратора.»
- «Синхронизация - это фактически заново запустить процесс обогащения.»

Codex was consulted read-only on the same evidence; its advice is folded in below and its
disagreements are named.

## Decision

**1. The writer is a graph of units.** Units are declared through the orchestrator's stage registry
(0027), each with what it reads and what it writes, and run in dependency order, resumable:

| Unit | Reads | Writes |
|---|---|---|
| Graph validation | nodes, edges, evidence, extraction gaps | a verdict per flagged item (section 3) |
| Document interpretation | each document's section tree and text | proposed semantic entities and relations (section 4) |
| Rules and decisions | their sections, implementation candidates, answers | rule enrichment; ADR structure and implementation links |
| Scenarios | actors, rules, routes, flows, decisions | actor, goal, preconditions, main and alternative flows, outcomes, implementation links |
| Domains | enriched scenarios, rules, service context | the business explanation, boundaries, open points, a developer section |
| Guides | scenarios, configuration, deployment, operations | the administrator guide and the user guide (section 7) |
| Overview | published summaries and coverage | the home page: a one-minute overview |
| Editorial | rendered pages, link index, glossary, questions | bounded revision requests (section 6) |

Rules and decisions run independently; scenarios consume them; domains summarise enriched
scenarios instead of rediscovering code; the overview is written last. Enrichment of a person's
document (a UC, a rule, an ADR) is stored apart from it, keyed by the source entity, and never
overwrites the person's text.

**2. The agent is given prepared context and tools that answer questions.** Each unit receives its
relevant subgraph up front, with evidence, so graph-first is enforced by what the unit holds, not
by counting calls (Codex). New tools in `src/writer/tools.ts`, backed by `GraphView`:
`get_symbol(name, service?)` (candidates, signature, exact source span, owner type, callers,
callees, references, tests), `get_context(entity, purpose)`, `trace_flow(entry, targets, bounds)`
(route → handler → calls → table access or event; reachability is never shown as order),
`get_document_sections(intent, scope)`, `search_pages`, `get_page(md|json)`,
`search_questions(includeAnswered)`. `read_file` stays for exact quotes. Every answer names the
repository, the pinned revision, the evidence and any truncation. Unit-specific instructions move
out of the shared prompt. The journal counts repeated source bytes, evidence inspected, unresolved
joins and what the unit produced, not only calls.

**3. Validation is anomaly-driven.** Every node and edge gets a disposition; most get it from
deterministic rules, and only flagged items go further, as the owner proposed. Rules flag: a node
with no edge; an import nobody calls, reads or implements; an export with no reference; a handler on
no route and a route with no handler; a database with no table; a table nobody reads or writes; an
environment variable read but defined nowhere, or defined but never read; a contract operation no
route serves; a channel with no consumer; an interface with no implementation; a test that tests
nothing; a deployment with no image. Flagged items go to jev in batches with the rule and its
evidence, then to the agent where jev is unsure. The verdict is one of: extraction gap (a fix is
filed and the node is not shown as fact), real finding (Problems, or a question), expected (the kind
or node is declared standalone, with the reason). Verdicts are cached by evidence and validator
version and kept in Markdown so a rebuild keeps them. Cost is bounded by the number of anomalies,
not the size of the repository; work not reviewed within the budget is reported as unreviewed.
Codex's correction is adopted: the owner's «every vertex» is met by a disposition on every vertex,
not by one agent per vertex; and a missing edge is never taken as proof of absence.

**4. Documents are read by meaning.** Every document is parsed into a tree of headings, paragraphs
and lists with source ranges. Sections are classified in three passes: explicit metadata and the
manifest's conventions; deterministic structure; jev classification into scenario, actor, rule,
quality requirement, decision, procedure, term or other; the agent splits a passage that holds
several meanings. A number such as UC-1 is an alias; stable identities live in a sidecar mapping so
a heading edit does not break links. The original section stays intact (an ADR keeps Status,
Context, Decision, Consequences). What the documents lack is said (no user stories).

**5. A question is asked once.** Before filing, candidates are retrieved across every status and
type by canonical subject, topic, entities and text; a typed judgement says same decision, related
or unrelated; a same decision returns the existing question or its answer to the agent. Check and
create are serialised. Questions are written in the wiki's language. Questions already filed are
not merged automatically; clusters are proposed with their provenance (Codex).

**6. The wiki is for people first.** An editorial unit reads the written pages as a newcomer:
whether a page says what it is for, whether one fact is stated the same way on every page, glossary
terms, internal jargon. It sends bounded revision requests to the units that wrote the pages. Every
mention of a known entity in agent text is a link, inserted by the core where the agent wrote plain
text, and every page lists the pages that mention it. Navigation lines are not statements; the
sentence splitter is one shared function that knows abbreviations.

**7. The documentation set follows Diátaxis**, with arc42 as a coverage check, not twelve empty
sections. Reference is the graph's pages; explanation is the overview, domains and decisions; how-to
is the administrator guide (environment, install, configuration, running, health, metrics, logs,
known failures) and the user guide (by the roles of the vision and the scenarios, through the API
while no frontend is connected). Nothing is invented: a backup procedure or a UI step without
evidence is a stated gap, and a procedure is accepted only by walking its steps.

**8. Templates use LiquidJS.** A base template per entity (`entity.liquid`), kind templates that
extend it (`{% layout "entity" %}` with `{% block %}`), shared partials (`{% render "partials/…" %}`)
and conditions (`{% if page.callers.size > 0 %}`). The engine's blocks become tags dispatched by
`renderBlock()`. `{{label}}` keeps working, and diagnostics keep file and line. Blocks get stable
identities instead of template line numbers. Data given to templates is plain and bounded; filters,
tags and template paths are allowlisted; product templates render in a process bounded in time and
memory, because Liquid's own limits are cooperative. Nunjucks was rejected: its documentation warns
that user-defined templates are not sandboxed.

**9. Sync is a refresh the reader can see.** «Синхронизировать» in the top bar reads new commits,
reruns extraction and the affected units, and shows what changed.

**10. Agents read the same pages.** Every page is served as Markdown and JSON from the same page
model, and each product has `llms.txt`.

## Consequences

- The milestone's tasks under madarch-mwhd, madarch-ztyq, madarch-u3vw and madarch-rckk implement
  this record; madarch-j6ho's checks (the walk of every page, the answer-key comparison) measure it.
- 0029's «a template holds no program logic» is replaced by «a template holds presentation logic
  only»; its data model and grounding rules stand.
- A fill costs more agent calls in total (more units) and fewer per unit (prepared context); the
  journal's new counters make the trade visible.
- What validation, interpretation and editorial passes decide is Markdown in the product repository,
  so a rebuild repeats no judgement whose evidence did not change.

## Not decided here

- The exact rule set of section 3 grows with each extractor; each rule is a named check with a test.
- The thresholds of jev batches and escalation are tuned on the training product and recorded with
  the validation task.
