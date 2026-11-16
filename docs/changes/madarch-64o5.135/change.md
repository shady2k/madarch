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
with the `components/ui` kit. The restoration uses generic graph reads, declared templates and existing kit
components. Remaining gaps are listed explicitly; this work is not accepted yet.

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
| Item | State | Evidence / remaining limit |
|---|---|---|
| 88, 90-92, 94 | preserved | Existing file tabs, facts, history and relation sections. |
| 89 | done | Address-specific tab memory; `wiki/app/src/tabs.test.tsx`. |
| 93 | done | `Cochange.total/share`, distinct commit counts and percentage; executor test covers duplicate edges. |
| 95-96 | merged dependency | PR #325 supplies file text, highlighting, wrap and Markdown modes. Protected file-text modules remain untouched. SourceText schema now names canonical `bytes`, without an alias, to match their query and the blob reader. |
| 97 | done | Partial branch's language-opinions table retained. |
| 98 | partly | Repository URL, branch, shallow flag, current commit and graph list totals. Steps, unread repositories and last-run state lack declared graph fields; not invented. |
| 99 | done for graph containment | Directory children and parent, repository direct children; totals and cursor paging. |
| 100 | partly | Existing kit treemap, folder controls, breadcrumbs, language legend, byte/line areas, paging and truthful last-change recency. Tile-click navigation is unavailable in the existing treemap API; folder links provide navigation. Commit-count heat over a window is not available from lastChange. Traversal is bounded to depth three rather than claiming arbitrary depth. |
| 101 | partly | Declared path/language/numeric-bound filters, column sorts and cursor reset. One filter at a time; combined ranges and commit heat are left. |
| 102 | partly | Repository/directory files to depth three. Module relations are not declared in the starter graph and are shown as unavailable. Unrelated service/package/module pages are outside this restoration. |
| 103 | done | Paged repository graph history with author, subject and descending commit date. |
| 104 | partly | Citation cards query graph-backed ranges and show language/cut links on symbol/operation/contract pages. No invented positions for kinds without declared location fields. Excerpts reuse PR #325 highlighting and existing kit syntax tokens with true cited line numbers; no new kit component is required. |
| 105 | partly | Actual `/src` address composes a template with graph file metadata and source text. Repo must be explicit; no guessed repository. Line anchors use the existing kit link; automatic focus/highlight of a requested line is not claimed. Large-file ranges continue by exact line/column and blob pin; a changed blob resets the text. |
| 106 | partly | Safe graph-provided host links through configurable source urlPath. Templates without a graph web URL do not invent provider-specific web routes. |
| 107 | unavailable | Starter graph declares no calls relation. Pages state that limitation rather than claiming the symbol has no calls. |
| 108 | partly | Generic member anchors, linked nested connections and explicit shown/total notice are implemented and tested. The starter graph lacks symbol-to-field and reader/writer relations, so its symbol page states they are unavailable. Nested relation continuation is not implemented. |
| 109 | partly | Graph column/index and declared-file relations restored. Current db-schema does not emit database-to-table containment; database tables without such an edge remain unavailable. Migration kind has no fields or producer. Old prefix guesses are not restored. |
| 110 | unavailable where undeclared | Starter graph lacks tests, implements/inherits, declared-by and served-by relations for these pages. Sections state the gap, rather than querying invented edge names. |
| 111 | left | Redoc/AsyncAPI/proto viewers and diagnostics need owner-approved kit capabilities and declared graph definition content. No embedded viewer or new kit component was added. |

### Current validation
- Native ordinary-user `bun run check`: passed with architecture **914 found / 914 listed**; baseline shrank from 947, with no new debt. UI architecture **0**. Catalogue 527 kinds, 84 page/member kinds; both starter selections validate.
- Wiki app check: passed. Full app suite: **159 passed / 0 failed**, 778 assertions after final source highlighting/anchor changes. Production app build passed (root build after ordinary-user build hit a root-owned Vite temporary folder).
- Final focused native integration: **95 passed / 0 failed**, 612 assertions across executor, schema, page contract, restored templates and architecture gate suites. Includes a real GraphQL response for source `bytes`.
- Revised template suites alone: **23 passed / 0 failed**, 299 assertions. Includes actual starter edge-contract validation; unsupported relation sections now state their limitation.
- Bounded manual mutations: reads **3/3**, templates **1/1** (a second historical member-anchor mutant is superseded by the unavailable member section), source **3/3**, treemap **4/4**, protocol architecture gate **5/5**, percentage formatter **1/1** killed and restored. This is a bounded sample, not a full mutation score.
- Browser smoke: **1 passed / 0 failed**, 77 assertions (latest capture run; all 36 screenshots recreated); 36 graph-backed screenshots cover nine kinds at 1440/390 px in light/dark. No page errors or measured horizontal overflow. Fixtures are sparse and the file blob is synthetic: connected relation and real source-content acceptance are not established. Available models cannot inspect images; visual acceptance remains pending.
- Full native suite completed in the foreground: **2,155 passed, 103 skipped, 9 failed** (2,267 cases; 2,710.83 seconds). Four CLI timeouts and two template failures passed in an isolated run of **118 tests / 0 failures**. The starter file inventory and generated SDL were updated; those and the architecture snapshot passed a final isolated run of **11 tests / 0 failures**. The full suite was not repeated after final edits; no full-suite green is claimed. All task-owned test processes and PostgreSQL servers have ended.
- Task is **not accepted or closed**. No new kit component is proposed. Highlighting and line links use existing components. Behavior acceptance and visual review are not inferred from implementation instructions.

### Assumptions and constants
- Lists use 20 rows; file maps use 100 per page, with explicit paging/subset notices. The initial 200-row map made the repository operation cost 5,695 nodes and exceeded the unchanged 5,000-node limit; all nine composed page operations now have a query-cost regression check.
- Recursive relations accept depths 1–3 and reject other values. File traversal uses three; modules are unavailable because the starter declares no relation; this does not recreate an arbitrary-depth map.
- Source text keeps its existing 256 KiB reader bound. Recency controls use 7, 30, 90 and 365 days and describe last-change dates, not commit counts.

## Out of scope
Items marked [known] elsewhere in the audit (37, 48), and every behaviour decision
0036 removed on purpose.

## Where it is seen

Kind: screen
Place: Repository, directory and code record pages, and their source citations at /src
Mockup: docs/changes/madarch-64o5.135/mockups/repository-1440-light.png

1. Open a repository or directory to browse files, its graph history and its map.
2. Open a symbol to read its declared facts and the explicit notices for unavailable relation lists.
3. Open a file's co-change tab to read the shared count and its denominator.

## Preserved contracts
None.

## Coverage
- product-wiki/graph-record-pages: restored-record-templates, graphql-executor, member-table, treemap-navigation
