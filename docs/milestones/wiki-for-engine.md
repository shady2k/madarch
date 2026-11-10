# wiki-for-engine — madarch is developed through its own wiki

Adopted 2026-11-10 (the owner's «Да» to the charter summary in conversation with
the coordinator). Follows wiki-for-people, closed the same day («Да, веху
закрываем.») after the owner found second surfaces still reading around the
graph. The owner set the goal:

«Я хочу от тебя чтобы мы с тобой подготовили фундамент, базу, архитектуру
решения. И уже начали с тобой заполнять вики, чтобы я мог видеть, что у нас
происходит, какие у нас таблицы, какая у нас архитектура, какие модули, с кем
взаимодействуют и так далее. Понимаешь? То есть я хочу использовать нашу вики
для разработки нашего движка.»

The engine fills nothing: every fact comes from a plugin, with static, agent and
network parts (decision 0035, items 16-32), and the wiki, its API and MCP read
only the graph. madarch's own wiki is the first product built on that
foundation, and the owner develops madarch by reading it.

## Outcomes and acceptance

O1: The engine is the mechanism only: tables are built from the manifest's
declarations alone, the git and files reader is the first plugin, the source
filesystem is a capability a plugin requests, the wiki, API and MCP read only
the graph, an invalid manifest is not loaded, and plugins carry versions, a lock
and a failure state.
Serves: journeys 4, 6 and 7 of docs/vision.md.
*Check:* adding a kind with fields to the manifest creates its table and removing
it removes the table; a planted read around the graph in the read path, and a
plugin opening a file without the capability, each fail `bun run check` or the
host; the git plugin fills madarch's repository; a manifest with an error is
refused with every error named; a fill on a second machine from the same
`madarch/plugins.lock` runs the same plugin versions; a plugin failing past its
bound is switched off with its reason shown, and switched on again.
*Signal:* the owner finds no second surface on a walk of madarch's wiki.

O2: A fill walks the catalogue's kinds in their dependency order and runs each
kind's plugins: a general agent plugin fills a kind that has no plugin of its
own, the agent writes a static plugin inside a turn where one is cheaper, every
model call is metered, a technical task appears where a static plugin could
replace the agent, a fill can target part of the catalogue, and a consistency
plugin checks the result.
Serves: journey 6.
*Check:* on a fixture product, a kind declared only by its description is filled
by the agent plugin with its model and tokens shown on its page; the dependency
graph page shows the order and progress; a fill of one kind with its
dependencies runs only what is stale.
*Signal:* the owner starts a fill of one section from the dependency graph page
and reads what it cost.

O3: madarch's own wiki shows its architecture: glossary terms, modules, entry
points (CLI commands, HTTP routes, MCP tools), stores and database tables, and
the relations imports, reads, writes and calls between them, each filled by a
plugin, and the module, table and architecture pages carry text whose every
sentence is a statement grounded in the graph (decision 0034, item 15).
Serves: journeys 1, 4 and 7.
*Check:* every term of madarch's docs/glossary.md is in its wiki with a link to
its lines; every CLI command, HTTP route and MCP tool of madarch has its entry
point page; the module map shows which module imports, calls, reads and writes
which module, store and database table; a planted module reading around the
graph appears on the map; every sentence on the module, table and architecture
pages links to its grounds, and a sample of sentences is checked against them by
a reviewer.
*Signal:* the owner answers from madarch's wiki alone which modules read which
tables and where a second surface would be.

O4: The Files section serves a reader as the owner's reference screens do: a map
of the repository with area and colour switches (lines, dependants, commits;
change frequency, language, age), a file table with a filter, and a file page
with its header (main authors, hotspot, figures) and the History and
Co-change tabs; and the wiki's addresses carry no /k prefix.
Serves: journey 4.
*Check:* side by side with the owner's ten reference screens (kept with the task
that builds it), each switch and the filter exercised; the figures of three
files checked against git; every link on the Files pages opens its page; no
address of the wiki starts with /k.
*Signal:* the owner finds a hotspot and its authors from the map in a minute.

## Exclusions

- The public read-only wiki of madarch linked from the README and the landing
  page (madarch-m5i7).
- The Tests, Health and Packages tabs of a file page, and the architecture map's
  communities and paths.
- Plugins that read external systems (madarch-pmjm): the network part a plugin
  may declare is built in O1, and no such plugin is written in this milestone.
- Product templates and the choice of kinds at initialisation.
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

15, as in wiki-for-people (`findingBudget` in `.shady2k/config.json`).

### Target date

None set from outside the project.

## Next horizon

- The public read-only wiki of madarch.
- The Tests, Health and Packages tabs; the architecture map's communities and
  paths.
- Plugins that read external systems.
- Updating by commit on every branch; people changing the wiki through the
  agent.
