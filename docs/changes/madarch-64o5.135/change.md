# Code, repository and folder pages: the first restored items, and what each remaining one needs

Change: madarch-64o5.135
Base: dd6c44f5
Tasks: madarch-64o5.135
Kind: behavior

## Intent
Restore, as items of /tmp/audit-299-lost.md sections 8-10, what a reader could do on
code, repository, folder, symbol, route, operation, contract, table and database
pages before PR #299, on today's template layer: templates under
`catalog/templates/pages/` read the graph through `/graphql`, and the app draws them
with the `components/ui` kit. This turn delivers the items that needed no new read
and no new component, and names every other item with the reason it is left.

## Design and decisions
- **Item 97, language opinions with their sources.** The code file's page gains a
  «Language opinions» table: each producer's stated language, its version, the
  language it was stated in and the moment, read from the file's own
  `languageOpinions` field (`catalog/templates/pages/code-file.yaml`). A file no
  producer states a language for says so.
- **Item 89, the last chosen tab remembered.** A page's tabs open on the tab the
  reader left that page on (`wiki/app/src/components/tabs.tsx`): the page's own
  address names the memory, and the first section of a tab is what is stored, so a
  language switch does not lose it. `wiki/app/src/tabs.test.tsx` reads it back from
  storage on a second render.

## Acceptance evidence
| Item | State | Why |
|---|---|---|
| 88 tabs Overview/History/Co-change | present | already on the template |
| 89 last chosen tab remembered | **done** | `tabs.tsx`, `tabs.test.tsx` |
| 90-92, 94 facts, latest, history, relations | present | already on the template |
| 93 co-change share (both / total = %) | left | the `cochange` root answers the pair's count only; the share needs the file's whole commit count beside each pair — a read change (`src/graph/graphql-read.ts`, `src/graphql/schema.ts`), named for the next turn |
| 95 file text, highlighted, wrap switch | left | the file's text is PR #325 (madarch-u3vw.16), file-text.tsx/file-texts.ts — not touched |
| 96 Markdown Rendered/Source switch | left | same file text, PR #325 |
| 97 language opinions with sources | **done** | new table on `languageOpinions` |
| 98 repository facts | left | the template is not built; `url`, `default_branch` and `history_shallow` are graph fields, so a `code.repository` template can carry them, while the unread repositories and the last run are run state, not graph — they need a command component |
| 99 folder listing | left | a `code.directory` template over `code.contains` (children) and its inverse (one level up) is the next turn's work; the read exists |
| 100 treemap of files | left | no `treemap` component exists and ECharts is not in the kit (decision 0020); a new kit component needs the owner's yes |
| 101 files table sort/filter | left | `instances` takes `first`/`after`/`lang` only; where and orderBy are missing from the read (`src/graphql/schema.ts`, `graphql-read.ts`) — the audit's "only the template is missing them" does not hold |
| 102 Files/Modules lists at depth 2-3 | left | needs the directory template (99) first |
| 103 repository history | left | the graph holds `code.history` (repository to commit), but no section reads a history shape (`history: repositories` is declared and unread); a history block component is a new kit component |
| 104 source card | left | cited lines are the file's text — PR #325 |
| 105 source page `/src?path=&line=` | left | file text and highlighting — PR #325 |
| 106 Open on host | left | the repository page's `url` can be a link in a template, but a file's link needs the repository's URL in the file's own query, which the generic schema does not answer (a reference field is a scalar); a read change |
| 107 callers/callees with a no-calls note | left | the relations component draws an empty note, but the starter catalogue declares no calls edge; a product that has one gets the note today |
| 108 members table | left | needs a members read (fields with readers and writers); the graph holds the fields as entities and the relations, a template over them is the next turn's work |
| 109 children: tables, migrations, columns, indexes | left | `code.has-column` and `code.has-index` exist; a `code.table` template with titled relation sections is the next turn's work |
| 110 Tests and types, Declared by, Served by | left | `code.declared-in` exists for tables; the other edges are the product's |
| 111 contract definition (Redoc, AsyncAPI, proto) | left | the definition text is the file's text (PR #325) and Redoc is not in the kit |

## Out of scope
Items marked [known] elsewhere in the audit (37, 48), and every behaviour decision
0036 removed on purpose.

## Preserved contracts
None.

## Coverage
None.
