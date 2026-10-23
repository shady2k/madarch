# Every agent call is journaled by the core and readable per page, and the writer keeps both sides of a contradiction, asks each question once and labels grounds by their names

Change: madarch-m38l.13
Base: 05af1efa4ccd3b72531c9f0c93fea0dd8d260982
Tasks: madarch-m38l.13
Kind: no-behavior

## Intent
The owner's walk of 0.2.2 on 2026-10-23 found that nobody could tell what the writer's agent had done (no record of its calls on the core's side), and that its pages had defects the prompts alone did not prevent: 21 questions of which 11 were distinct, a contradiction moved off the page into a question (the Ordering page lost the 90-day/6-hour retention and the 8% tax), ground labels the agent invented («Ожидание» for `withTimeout`), a service named by a link and grounded only on that link, routes and operations written as code spans, question headings in English in a Russian wiki, and an asymmetry the run missed (a refund with no timeout or retry beside a pay call that has both). This change makes the core journal every call and shows it per page, and moves what is deterministic out of the prompt and into code.

## Rationale
The writer's format, checks and prompts are specified by decision 0029 and its design records, not by a capability file, so no capability text changes; the journal route adds an address and keeps the existing ones. See "Design and decisions".

## Out of scope
- Real agent runs; every behavior is proven with the scripted ACP test agent the writer tests use.
- OTel export: the records carry OpenTelemetry generative-AI attribute names so an exporter can forward the lines unchanged, and none is built.
- Journals of the fill's own stage agents (`src/fill`), which have their own unit-tool path; only the knowledge writer is journaled.
- The reader-shell files of madarch-m38l.12, except the one link on an agent-written page.

## Changes to requirements
None.

## Preserved contracts
- product-wiki/serve: the routes keep their addresses; one route is added.

## Coverage
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: a product page the agent wrote, then its journal page
Mockup: docs/changes/madarch-m38l.13/shots/en-light-wide-journal-refusals-open.png

1. A person opens a page an agent wrote (the product page or a domain page); under its title a link says «Как агент писал эту страницу».
2. The journal page opens: the run, the agent, the model, the session, the number of tool calls, the number of refusals and the time spent in calls; then one row per record in the order they were made.
3. A row opens to the full arguments, the full response (with its size, and a note when it was cut), and, for a refusal, why. A checkbox keeps only the refusals.

## Blocking questions
None.

## Design and decisions
- The journal is core-side and per run: `src/writer/journal.ts`, JSON lines in `<store>/<product id>/journal/<run>.jsonl`, in the product's machine-local store and never in the product repository. A run id is `run-<UTC time>-<4 hex>`. A record (`madarch.agent-journal@1`) holds the run, unit (the id of the page it writes), agent, model (`models.currentModelId` of `session/new`, null when the agent says none), session, kind, tool, the full arguments, the response (cut at 100 000 characters, with `responseBytes` and `truncated`), `isError`, the outcome (`ok`, `refused`, `failed`, `rejected`), the reason, the start time and the duration, and an `attributes` object with the OpenTelemetry names (`gen_ai.tool.name`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.conversation.id`) so an exporter forwards the lines unchanged. A write that fails raises with the file named; nothing is dropped silently.
- It is written by the process that serves the agent's tools (`serveTools` in `src/writer/acp-agent.ts`, the server), so it records what the agent asked and was answered. Kind `tool-call` is one record per call the unit's tools answered, which is exactly the count `UnitOutcome.calls` reports and the progress block shows («вызовов инструментов: N»); a test asserts the equality over the real tools and over the wiki's product. Kind `refusal` is a request madarch did not serve as a call: a `tools/call` for a tool the unit does not have, and, from `connectAcpAgent`'s new `onRefused` hook, every `fs/*`, `terminal/*` and permission request of the agent.
- `GET /api/k/journal?id=<page id>[&run=<run>]` answers the newest run that wrote the page (or the run asked for) with that unit's records, the runs that wrote it, and the lines it could not read, each with file and line. The page is `/k/journal?id=…` (`wiki/app/src/knowledge/journal.tsx`); the only change to the reader shell is the link under the title of a `product:` or `domain:` page.
- Dedupe is code. Each unit's tools read the questions asked so far (earlier runs and earlier units) at each ask. A new question whose entities (its `about` and its sides' grounds, without the broad containers: services, modules, files, pages) share one with an existing question of the same type adds its page to that question instead of saving another; an answered question is not asked again and the agent is handed the answer and the id to stand on. The entities of a question's sides are stored in its `about`, so later questions find it. The prompt lists the questions asked elsewhere in the product with the entities each is about.
- Both sides of a contradiction stay on the page, in code: a unit that asked a contradiction cannot write a page that grounds no side's source (a ground in the same file counts), and `write_page` names the missing side and where to ground it. The prompt says why.
- Ground labels come from names, in code: every footnote ground is shown by the graph's label of the entity or the heading of the document section (an identifier such as UC-2 as written), whatever the agent wrote.
- A link is not a ground, in code, for the case a check can know: a sentence whose only grounds are the service or module it names by a link is refused. The prompt's example no longer teaches it. Whether a ground otherwise supports its sentence is the agent's judgment, and the prompt says so.
- Routes and operations are links, in code: a code span in the body that is `METHOD /path` of exactly one route, or the exact name of exactly one symbol, becomes a link to it; a span that names nothing or something ambiguous stays as written. Headings, footnote lines and what already sits in a link are left alone.
- Question headings come from the wiki's language: `renderQuestion` writes Вопрос / Почему это важно / Что говорят источники / Ответ in a Russian wiki, `parseQuestion` reads either set and remembers which, and answering rewrites the file in its own language. Files written before this change are English and stay readable.
- The neighbouring-operations comparison (answer key `payments.refund-no-resilience`) is the prompt's: the domain unit is told to compare how each operation that calls another service or a store handles a timeout, a retry, an error answer and a repeat, and to state a difference as a grounded sentence and ask when no document says whether it is intended. No code can decide that two operations should be alike, so this one is asked and not enforced.
- Known limits: the dedupe overlap is on entities, so two different questions about one function are merged, and an agent that names no entity is not deduplicated except by an identical title; the link rule refuses only a container named and used as its own ground; the journal is per machine, so a page written elsewhere has none.

## Acceptance evidence
See the worker report; the checks run on the SkyPilot pool and in CI on the pull request's head.

## DONE WHEN
Every call of a writer run is a record in the product's machine-local journal, refusals included, and the count of «вызовов инструментов» equals the records' count; the journal page shows them behind «Как агент писал эту страницу»; and the writer deduplicates questions on their entities, keeps both sides of a contradiction on the page, shows grounds by their names, turns routes and operations into links, refuses a container used as its own ground, and writes question headings in the wiki's language, each proven with the scripted agent.
