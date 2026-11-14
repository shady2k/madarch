# Is every page useful? — madarch-64o5.71 review

Status: a review for the owner. No product code changed. The question asked:
«проверь, что каждая страница полезна людям. Что это не просто набор текста» —
is each page a thing a person can use, or a pile of fields?

## What was reviewed, and how

A fresh product, `madarch init --template everything`, over a real repository:
this one — `github.com/shady2k/madarch`, cloned to /tmp/src with 200 commits of
history, linked as the product's `src` repository. It was served by the daemon
and filled **from the wiki's API with the deterministic plugins only**
(`POST /api/fill-selected {"selected": [all 83 kinds], "pluginsOnly": true}`) —
no agent, no tokens, as the review asks.

What the graph then held:

| Kind | Records | Kind | Records |
| --- | --- | --- | --- |
| code.file | 3,934 | code.commit | 2,491 |
| code.directory | 1,341 | code.package | 78 |
| value-set-entry | 27 | code.author | 19 |
| value-set | 5 | code.repository | 2 |
| product | 1 | | |

The fill ended `completed_partial`: the database-schema plugin abstained (the
repository has no database), and the glossary plugin missed its heartbeat on
this repository's `docs/` and was recorded as not extracted. Every other
plugin ran. Author-written kinds (documents, decisions, tasks, practices) are
empty **by design of this review** — no agent was allowed — so a page that
looks empty because nobody has written it is not counted against it; a page
that looks empty when the graph *does* hold data is.

Pages were walked in a headless Chrome at 1440×1200, and the five most
important at 390×844 too, from the running wiki: home, catalogue, a kind page
(eight kinds), entity pages (file, folder, repository, commit, author, package,
value set, value-set entry, product), search results, glossary, Problems,
Sources, Runs, a run page and Settings. Screenshots: `docs/explorations/pages-shots/`.
Every claim below comes from the rendered page (its text, its empty states, its
errors), not from the code.

## The short verdict

| Page | For whom | Verdict |
| --- | --- | --- |
| Home | newcomer, product owner | **Thin**: four count cards; no description, owner, lifecycle or last fill — it says what the graph holds, never what the product is. |
| Catalogue | analyst, architect | **Useful**: the product's whole map with areas, kinds, counts, producers and state; long but scannable, and every row leads somewhere. |
| Kind page (File) | architect, developer | **The most useful page in the product**, and it mixes two pages into one: a definition (what a file is, its audience, who fills it) and a repository dashboard (by language, by folder, largest, most changed, records). |
| Entity: file | developer | **Useful**: facts, authors, changed-by, and six diagram tabs — but "Leads to imports · 0" is noise, the diagram block is heavy, and the file's own content is not shown. |
| Entity: directory, repository, package, author | developer, ops | **Thin**: 400–1000 characters; counts and lists, no summary of what the thing is for. |
| Entity: commit | developer | **Broken**: the page renders a raw database error instead of the commit (see the first fix). |
| Entity: value set, value-set entry | analyst | **Thin**: a title and two empty relation boxes. |
| Entity: product | product owner | **Thin**: a title, an empty diagram and two empty relation boxes. |
| Search results | everyone | **Broken in effect**: "Nothing matches this search" for `fill` and for `madarch` — the words are in 3,934 filled files and hundreds of paths. |
| Glossary | newcomer | **Empty by design**, but its empty state speaks of a "fill stage" — internal language where an invitation belongs. |
| Problems | product owner, ops | **The second most useful page**: 166 findings with severity, who fixes them, place, evidence and two actions. Its banner ("the documents section is not judged…") is engineer-speak. |
| Sources | analyst | **Thin**: two repositories and a filter; the documents the wiki rests on are not listed. |
| Runs | ops | **Half a page**: each run prints the whole list of 74 kinds as one sentence, and hides the numbers that matter (units published, duration, failures). |
| Run page | ops | **Half a page**: "Published 96 of 100 units", two timestamps and the same kind list; no per-unit failures, no log, no link back to what changed. |
| Settings | product owner, ops | **Useful and honest**: the agents, what an install costs, language and roles — technical, but every paragraph answers a decision. |

The pattern: pages built on a *kind* (catalogue, kind page, Problems) are
useful; pages built on *one record* of a plugin-filled kind are a field dump;
pages that depend on authored content are empty and say so in the wrong words.

## Page by page

### Home — `/`

**The person's question.** Newcomer, product owner: *what is this product, what
does it hold, and what needs me now?*

**Now.** The product's name, a Repositories card (two repositories, their
branches), "What the graph holds" (nine counts), "By language" (14 languages
with file counts), "Files by repository" (two bars), and a role question
"Which role do you read as?" thrown in at the end. 372 characters of content.
Nothing says what the product is for, who owns it, when it was last filled,
what changed, or how many problems are open — although the sidebar shows
`Problems 166` and the graph holds a `product` entity.

**How the leaders do it.** Backstage's catalog gives every entity a page that
opens with an *About* card (description, owner, lifecycle, links) before any
table — https://backstage.io/docs/features/software-catalog/system-model/.
Port's entity page adds scorecards (initiatives, alerts) above the lists.
GitHub's repository home answers "what is this and what happened lately" with
a README and a pulse: https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/about-repository-graphs.

**Not a decision (a).** Put the `product` entity's title and description at the
top, with the last fill (state, when, units) and the open problem count; drop
the duplicate "Files by repository" bar when there is one repository.

**Needs the owner (b).** Home as an *overview card*: owner, purpose, lifecycle,
last fill, open problems, recently changed entities — the Backstage/Port
pattern, one screen that answers "should I care?".

### Catalogue — `/p/catalogue`

**Question.** Analyst, architect: *what kinds does this product have, how full
is each, who fills it, and what should I fill next?*

**Now.** 26,000 characters: areas ("Strategy and business motivation", …) with
their kinds, each row a count, a state and a producer; a filter box, an area
selector and "Choose for filling". Every row opens the kind's page. It is dense
but navigable, and it is the only page that teaches the vocabulary.

**How the leaders do it.** Backstage's catalog table lets you filter by kind,
owner and tag and sorts by what you choose; DataHub's browse does the same by
domain and entity type: https://docs.datahub.com/docs/features.

**Not a decision (a).** Say in one line what "state" and the producer names
mean; group the empty kinds under "nothing written yet" rather than mixing
them with filled ones.

**Needs the owner (b).** A second column of *what a person can do next* —
the catalogue already has "Choose for filling"; make it the primary action per
row ("fill these 12 kinds with the plugins").

### A kind page — `/e/catalogue/<id>` (e.g. File)

**Question.** Architect, developer: *what is this kind, who is it for, and
what does the product hold of it?*

**Now.** Two pages in one. Above: "What it is" (a definition), Area, Subgroup,
Purpose, Audience ("Developer, Architect"), "In the product: Yes", Sources,
and the fill state. Below: "Files in the repositories now 3,934 / over the whole
history 5,108", "By language", "By folder" (with `plugins/*/node_modules/...`
in the list), "Largest files", "Most changed", "Time since the last change"
(three empty buckets shown as zeros), and a 128-row records table (path,
language, class, lines, last change).

**How the leaders do it.** This is close to a *catalog entity* page plus a
*CodeScene* code-health page; CodeScene puts hotspots and change coupling on
the repository, and per-file health on the file
(https://codescene.io/docs/guides/technical/hotspots, 403 to this box's
fetch). GitHub never mixes a type's definition with a repository's statistics.

**Not a decision (a).** Exclude `node_modules`, vendor and fixtures from the
folder and size lists (or mark them); drop zero-only buckets; explain "class:
dependency"; and stop repeating "By folder" and "Files by repository" on two
pages.

**Needs the owner (b).** Split it: *kind* (definition, fields, producers,
audience) and *records* (table + statistics), so a reader who wants the
definition never scrolls past 128 rows.

### Entity: a file — `/e/code.file/<id>`

**Question.** Developer: *what is this file, who owns it, what does it depend
on, and what changed it?*

**Now.** Breadcrumb (`Files / src / vendor / archify / renderers / shared`), the
path twice (crumb and title), tabs Overview / History / Co-change, facts
(Language, Type, Lines 132, Size 6.9 kB, Last change, Commits 6, Repository,
Folder), "Around it" with six diagram tabs (LikeC4, Mermaid, archify), "Last
change", Authors (shady2k 4, madarch agent 1, Korachentsov Alexandr 1), "Leads
to imports · 0", and "Changed by" — five commits with message, date and author.
The page took 30+ seconds to become ready in the walk (the diagrams).

**How the leaders do it.** GitHub's file page shows the content, blame and
history (https://docs.github.com/en/repositories/working-with-files/using-files/viewing-a-file);
CodeScene adds hotspot score, change coupling and ownership share; Sourcegraph
gives symbol navigation and references
(https://sourcegraph.com/docs/code-search). Ours names the authors and the
commits but not the *share* of changes or the coupling, and shows no content.

**Not a decision (a).** Hide "Leads to imports · 0" when zero; show "and 5
more" on the commit list with a link to the kind page; cut the duplicate path;
one "Diagram" tab with a renderer choice instead of three.

**Needs the owner (b).** Add what makes a file page *decide* something: change
coupling ("changes with …"), a hotspot score, the ownership share, and the
file's first lines beside the facts.

### Entity: a directory, a repository, a package, an author

**Question.** Developer, ops: *what is this thing and what is under it?*

**Now.** 400–1000 characters: a title, counts, a short table, and often "Nothing
leads out of it". The repository page (14 rows) says nothing about the
repository's purpose, languages or activity.

**How the leaders do it.** Port/Backstage repository entities carry an owner
and a description; GitHub's repository page opens with the README and a
language bar; CodeScene's repository view leads with hotspots.

**Not a decision (a).** Do not render empty "Leads to / Linked from" boxes;
report the counts as a sentence with the kind's word, not a bare table.

**Needs the owner (b).** For the repository entity: README summary, language
mix, activity sparkline, top hotspots, owners; for the directory: its files by
change frequency.

### Entity: a commit — `/e/code.commit/<id>`

**Question.** Developer: *what did this commit change and why?*

**Now. Broken.** The page body is
`database owner "postgres:///…": operator does not exist: text -> unknown;
current transaction is aborted…`. The Commits *kind page* fails the same way,
so a reader cannot reach a commit at all. This is the review's first fix.

**How the leaders do it.** GitHub shows the message, the diff, the files and
their owners; CodeScene links a commit into its file hotspots.

**Not a decision (a).** Repair the query; then show the message, the files
touched with their kinds, and the author.

### Entity: a value set, a value-set entry, the product

**Question.** Analyst: *what values does this field take?* Product owner:
*what is this product?*

**Now.** A title, sometimes a description, and two empty relation boxes
("Nothing leads out of it", "Nothing links to it yet"); the product entity adds
an empty diagram frame.

**Not a decision (a).** For these kinds, show the authored body when the graph
holds one; hide the relation boxes until there is a relation; for the product,
show the manifest's description.

### Search results — `/p/search?q=…`

**Question.** Everyone: *where is the thing I am looking for?*

**Now. Nothing.** `q=fill` and `q=madarch` both answer "Nothing matches this
search", while the graph holds 3,934 files, 2,491 commits and paths that
contain both words. Whatever the search indexes, it does not index what the
plugins filled, and it does not say what it searches.

**How the leaders do it.** Sourcegraph answers with grouped results per
repository and file, filters by type and path, and a symbol sidebar
(https://sourcegraph.com/docs/code-search); DeepWiki answers *in words* over a
repository (https://deepwiki.com).

**Not a decision (a).** Say plainly what is searchable ("documents and
entities, not code content") until code search exists, and make the search
cover entity titles and paths — that alone would match thousands of records.

**Needs the owner (b).** A real code/entity search with filters and a symbol
side — the largest single capability gap this review found.

### Glossary — `/p/glossary`

**Question.** Newcomer: *what do the words in this product mean?*

**Now.** "No fill stage has written a glossary term yet" — an empty state that
names our pipeline, not the person's job. The glossary plugin timed out on this
repository, so the page is empty for a second reason too.

**How the leaders do it.** Confluence and Notion glossaries are authored pages
with owners and comments; Notion marks a page *verified* with a date
(https://www.notion.com/help/wikis-and-verified-pages).

**Not a decision (a).** Reword: "No glossary terms yet. A person or an agent
writes them; the glossary plugin reads `docs/` when a fill runs."

### Problems — `/p/problems`

**Question.** Product owner, ops: *what is wrong, how bad, and what do I do?*

**Now.** 166 findings, filter chips (All / In the code / In the documents / In
the wiki), and per finding: title, kind ("Large file"), severity, who fixes it,
place with file and line, evidence, and two actions ("Not a problem", "Create a
task"). A banner at the top reads "the documents section is not judged:
Markdown questions are retired; generic authored entities do not declare
document predicates" — true, but written for us.

**How the leaders do it.** CodeScene's code health review, GitHub's code
scanning alerts and Linear's triage all group by rule and severity, and make
the triage action one click (https://linear.app/docs/projects).

**Not a decision (a).** Replace the banner with a sentence a person can use
("Document checks are off for this product"), show counts per severity above
the list, and group the list by rule.

**Needs the owner (b).** Turn "Create a task" into a real hand-off with a
status per finding (accepted / dismissed / fixed) that survives the next fill.

### Sources — `/p/sources`

**Question.** Analyst: *what does this wiki rest on?*

**Now.** Two computers ("the product repository", "src"), each "On this
machine · Read by a fill", a filter box, and "No source matches." before
typing. The documents and statements every page rests on are not listed.

**How the leaders do it.** DataHub's lineage view answers exactly this for data
(https://docs.datahub.com/docs/features); Backstage's TechDocs links a
component to the docs it owns.

**Not a decision (a).** Drop the premature empty state; list the sources that
were actually read (the repository and the documents the disk plugin filled).

### Runs and a run page — `/p/runs`, `/p/run?run=…`

**Question.** Ops: *what ran, did it work, what failed and why?*

**Now.** Each run in the list prints "Published 96 of 100 units", two
timestamps in US format (`11/15/2026, 2:09:29 AM`) and then the entire list of
74 kind names as one sentence; a third entry says "Published 0 of 15 units".
The run page repeats the same and adds "Partly completed". The reasons the fill
was partial (the database plugin abstained, the glossary plugin missed its
heartbeat) are not on the page, though the status API holds them.

**How the leaders do it.** A CI run page (GitHub Actions) leads with state,
duration and the failed steps, each with its log.

**Not a decision (a).** Show state, units published/failed, duration and the
failing unit names with their reasons; put the kind list behind a disclosure;
format the dates in the reader's language.

**Needs the owner (b).** A run page as the ops view of one fill: units by
state, failures with reasons and a retry, the log, and what changed since the
previous run.

### Settings — `/p/settings`

**Question.** Product owner: *who writes the pages here, in what language, and
what may I change?*

**Now.** 3,435 characters: the agent choice (Claude Code, Codex) with what an
install costs ("about 314 MB", "about 462 MB"), sign-in state, language, roles.
Technical, but every paragraph answers a decision, and the numbers are honest.

**Not a decision (a).** Fine as it stands; the page could name the current
choice in its first line instead of defining what an agent is.

## The fixes that need no decision

1. **The commit pages render a database error** (`operator does not exist:
   text -> unknown`) — the Commits kind page and every commit entity page.
2. **Search finds nothing** for words that thousands of records contain; at
   minimum search entity labels and paths, and say what is searched.
3. **Runs dump 74 kind names per run**; show numbers, duration and failures,
   and the kinds behind a disclosure.
4. Timestamps are `11/15/2026, 2:09:29 AM` in every language; use the reader's
   format.
5. Zero-value lines ("Leads to imports · 0") and empty relation boxes should
   not be drawn.
6. The glossary's empty state names a "fill stage"; say it in the reader's
   words.
7. `node_modules`, vendor and fixture folders flood the kind page's folder and
   size lists.
8. The file page repeats the path and offers three separate diagram tabs for
   one picture.
9. Sources shows "No source matches." before anyone typed, and lists no
   documents.
10. Home shows no description, owner, last fill or problem count although the
    graph holds all of them.

## The proposals that need the owner

- **Home as an overview card** (owner, purpose, lifecycle, last fill, open
  problems, recently changed) — Backstage/Port pattern.
- **Kind page split** into *what it is* and *what it holds*.
- **File and repository pages that decide something**: change coupling,
  hotspot score, ownership share, README/activity for a repository, a code
  preview for a file.
- **A real search** over entities and code, with filters and symbols.
- **A run page as an ops dashboard**, with failures, reasons, retry and a diff
  against the previous run.
- **One "recently changed" feed**, and owners shown on every page that has one.

## What this review could not see

The fill was plugins-only, so every authored kind (documents, decisions,
tasks, practices, guides) is empty; their pages were reviewed as *empty
states*, not as content. The glossary plugin failed on this repository
(heartbeat), and the database plugin abstained by design. A second pass with an
agent and a token cap would answer the remaining question — whether the
authored pages (document, decision, task) are as thin as the plugin-filled
ones.
