# One fill runner, one store per product, and the repository pages a reader sees

Change: madarch-8bdc.2.5
Base: 972a6cd14a6b725ed5def04e7dd7da50691fef76
Tasks: madarch-8bdc.2.5
Kind: behavior

## Intent
Decision 0033 makes the fill one algorithm with one entry (items 1, 3, 6 and 15) and makes the graph the
one thing its stages publish and every reader reads. This step is the stage's first landing on that
shape: the fill is one runner, `runFill`, with one list of steps — the repository's tree and its history,
published into the record tables of the normal form — and every surface that starts a fill goes through
it: the wiki's button, `madarch fill-stages`, the daemon's update and `madarch mcp`. A product has one
store, resolved by one function, so a fill started by any surface is the store every reader reads. The
stages that are not in this step's list stay declared in the registry — the workflow check reads them —
and a run enables only the steps of the one list; a test whose case reads a stage out of the list is
named in `test/fill-skip-list.ts` with the stage that brings it back, never given a private runner.

On that store the MCP server answers the repository as it is: `list_files`, `get_file`,
`get_file_history`, `get_commit` and `get_repository` read the record tables only, and every answer names
the as-is commit it is true at, the paths the working tree changed and every gap the fill recorded. The
seven tools of decision 0032 are still served and say that their step has not run, naming it, rather
than answering an empty page. The wiki shows what a reader came for: an empty product with the fill's
button, the run's progress read from its own trace, the end state with the counts and the time, a failure
with its file, line and path, and then the repository, its folders, its files with every fact the graph
holds of them, its commits and the run page with each step's wall clock, peak memory and slowest names.

The benefit is the one the task's stage names: the fill's shape is settled before the later stages are
ported onto it, and a reader of a product can see the repository the fill read — the files, their
metadata, their history — in the same store an MCP client extracts the same facts from.

## Rationale
A second runner or a second wiring is what the one-fill rule exists to refuse: a fill started by the
button and a fill started by a command that read different stores left the wiki and `madarch mcp` with
nothing, and a stage list kept in two places diverges. The step list is therefore a constant of one
module and the registry declares every stage it knows: the workflow check reads the declarations, and
the run narrows the configuration to the list, so a stage out of the list is declared and never reached.

The record tables are the normal form the owner asked for — one value stands once, no versioning, as-is
only — and the pages are drawn from them, so the wiki holds no fact of its own. The MCP answers read the
same tables: an agent and a reader see the same files, the same blobs, the same dates. A gap the fill
recorded is stated in every answer, because a silently smaller answer is the defect the fill's coverage
rules exist to prevent. A tool whose step has not run says so, because an empty page from a graph that
was never written is indistinguishable from a repository that holds nothing.

The trace is the run's one record: progress, the run page's numbers and the peak memory a reader looks
for are read from it and nothing else, and the memory is sampled while the run goes rather than read at
a step's end, which is not a peak.

## Out of scope
- The agent stages of decision 0026 (8 to 13) and the narrative stage: they stay declared in the
  registry and out of the fill's list, and they come back by adding their ids to `FILL_STEP_IDS`
  (`src/fill/steps.ts`) — the first agent stage's step. The agent unit machinery is untouched.
- The stages out of the list that read the temporal graph (snapshot, inventory, build and configuration,
  syntax, code facts, the code pass, the data model, the state machines, the operations, the links, the
  modules, the document index and the history stage): their code stays, the fill does not reach them,
  and `test/fill-skip-list.ts` names every suite whose cases read them, with the stage that brings each
  case back.
- Removing PGlite: the one store is a PGlite folder today, and moving it to another owner is its own
  branch; this change resolves *which* store, never how a store is opened.
- The vector index and every query that reads it: the record tables carry no vector and the search
  surface of the knowledge wiki is unchanged.
- The wiki's page model over the temporal graph (a page's blocks, its statements, its diagrams): it is
  the static stages' reading and stays as it was; this change adds the repository's own pages beside it.

## Changes to requirements
- fill-orchestrator/runner (new): one runner, `runFill`, starts every fill — the wiki's button,
  `madarch fill-stages`, the daemon's update and `madarch mcp` — with one list of steps; a run enables
  only the steps of that list; a step a caller names that the list does not hold is refused by name; the
  run leaves its trace at `<store>/traces/<run>.jsonl`, and its progress and the run page's numbers are
  read from it. Scenarios: `one-runner`, `one-step-list`, `steps-out-of-the-list`, `the-runs-trace`.
- fill-orchestrator/store (new): one product has one store, under the knowledge root of the products
  home, named by the product's id (a checkout that is no product by its folder's name), and the button,
  `madarch fill-stages`, the daemon, `madarch mcp`, `madarch trace` and the wiki's reader resolve it
  through one function; a run that succeeded finishes the store the way the button does — the
  `knowledge_fill` pins and a numbered snapshot — and a product whose name is also a connected
  repository's names its own repository `<name>-product`, so two checkouts never share one id.
  Scenarios: `one-store`, `one-resolver`, `finished-store`, `two-repositories-one-name`.
- fill-orchestrator/host (changed): the background server still owns the orchestrator, and its runs go
  through the one runner; the process keeps one owner per store it fills, and the store's progress, pause,
  stop and update read that store. Scenarios: `nothing-opened`, `owned-by-the-server`, `one-run`.
- fill-stages/records (new): two passes publish the normal form — the tree pass the paths, modes, blobs,
  sizes, text or binary, line counts, languages with every candidate, gitlinks and folders as vertices;
  the history pass every commit, its parents, its author, both dates with their UTC offsets, its subject
  and every path it touched — and a pass retracts only the gaps it can produce. Scenarios:
  `the-tree-pass`, `the-history-pass`, `gaps-belong-to-a-pass`.
- fill-stages/steps (new): the fill's steps are one constant list in one module; the registry declares
  every stage this engine knows so the workflow check reads them; a run enables only the steps of the
  list; a suite whose cases read a stage out of the list is named with the stage that brings it back.
  Scenarios: `one-list`, `every-stage-declared`, `a-suite-out-of-the-list`.
- product-wiki/repository-pages (new): the wiki shows the repository the store holds — its own page with
  its url, branch, as-is commit, counts and gaps; a folder's page with its subfolders and one page of its
  files; a file's page with its mode, blob, bytes, lines, form, language and candidates, the commits and
  authors that created and last modified it, its authors and its history following renames; a commit's
  page with its author, both dates with offsets, its parents and every changed path — each naming the
  as-is commit and linking to the others, and no page for a step that has not run. Scenarios:
  `repository-page`, `folder-tree`, `file-page`, `commit-page`, `no-page-before-its-step`.
- product-wiki/fill-states (new): an empty product offers the fill's one press; a running fill shows the
  units and spans its trace states; the end state carries the counts and the time; a failure names its
  file, line and path; a declared repository with no commit is named with its path and the fill says what
  it did for it; the top bar names what the fill read until an agent has written a page. Scenarios:
  `empty-and-press`, `progress-from-the-trace`, `end-state`, `failure-with-its-place`, `a-repository-with-no-commit`.
- mcp-server/record-tools (new capability): `madarch mcp` serves `list_files`, `get_file`,
  `get_file_history`, `get_commit` and `get_repository`, read from the normal form only, each answer
  naming the as-is commit, the paths the working tree changed and every recorded gap. Scenarios:
  `five-tools`, `list-files-pages`, `file-facts`, `history-follows-a-rename`, `commit-facts`, `repository-facts`.
- mcp-server/later-steps (new capability): the seven tools of decision 0032 stay served and answer that
  their step has not run, naming it, rather than an empty result; a store that holds a temporal reading
  of this commit serves them from it. Scenarios: `the-seven-name-their-step`, `a-store-with-a-reading`.

Complete proposed capabilities: `capabilities/fill-orchestrator.md`, `capabilities/fill-stages.md`,
`capabilities/product-wiki.md` and `capabilities/mcp-server.md` (new). Every accepted requirement of the
first three is retained verbatim from Base, and the new or changed ones stand after them; `host` is the
one changed requirement and its text is in the proposal.

## Preserved contracts
- product-wiki/pages: the product's documents are still the wiki's pages, drawn from the store the fill writes; this change adds the repository's own pages beside them and changes no document page.
- product-wiki/live: a page still follows its file as it is saved, and the fill's end still moves the revision the open pages read.
- product-wiki/serve: serving a product is still one read of its working tree; the repository pages are routes of the same server and add no second store.
- fill-stages/registry: a stage is still one module plus one registration, refused twice under one id; the registry now declares every stage this engine knows.
- fill-stages/configuration: the product's manifest still enables, disables and limits a stage; a run narrows the resolved configuration to the fill's steps and changes no other field.
- fill-orchestrator/plan: a unit is still planned only when what it stands on moved, and a second run of one commit plans nothing.
- fill-orchestrator/publish: a publication is still one transaction per unit generation, fenced and exactly once; the record passes publish in one transaction of their own and are no second writer.
- product-repository/draft: `madarch new` still writes the starter set and a draft's manifest reads as before; the store is resolved under the products home and the draft is unchanged.

## Coverage
- fill-orchestrator/runner: test, static
- fill-orchestrator/store: test, static
- fill-orchestrator/host: test
- fill-orchestrator/git-floor: test, static
- fill-stages/records: test, static
- fill-stages/steps: test, static
- product-wiki/repository-pages: test
- product-wiki/fill-states: test
- mcp-server/record-tools: test
- mcp-server/later-steps: test
- mcp-server/source-on-every-answer: test
- mcp-server/command: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/publish: test
- product-repository/draft: test

## Blocking questions
None.

## Design and decisions
**One runner and one list.** `src/fill/run.ts` holds `runFill`: it opens the run's trace, resolves the
folder as a product or a checkout (`fillFolderIdentity`), narrows the resolved configuration to the steps
the caller names — the one list's, or fewer — and drives the host. `src/fill/steps.ts` holds
`FILL_STEP_IDS = ['repository-history', 'repository-tree']`, `fillSteps()` and `fillWritesPages()` (which
asks the engine's declarations whether any step is a stage with tools). A step out of the list is not in
the run's configuration and is never planned; the registry (`src/fill/stages/index.ts`) still registers
every stage, so `bun run check`'s workflow check reads the ids a product may name.

**One store.** `src/product/store.ts` is the one resolver: `knowledgeRootOf(productsHome)`,
`storeFolderOf(root, id, manifest)`, `productStoreFolder(folder, root)`, `storeDatabasePath` and
`storeSnapshotsFolder`. A store's id is the manifest's, or the folder's name for a checkout; a product
whose own name is also a connected repository's pins its own repository `<name>-product`.
`finishKnowledgeStore` writes the `knowledge_fill` pins and the numbered snapshot every reader opens, and
the button, `madarch fill-stages`, the daemon's update and `madarch mcp` all call it.

**The normal form.** `src/graph/records.ts` creates the record tables and publishes one tree and one
history of one repository: a node per kind, dictionaries for paths, languages, blobs and gaps, one
`edge` row per relation, and `touched` for what a commit changed. The reads the pages and tools use —
`listFiles`, `fileFacts`, `fileHistory`, `commitWithPaths`, `folderFiles`, `folderChildrenOf`,
`listDirectories`, `listRepositories`, `repositoryFacts` — are the store's own, each inside a span.

**The MCP server.** `madarch mcp` resolves the same store, fills it through `runFill` when it does not
hold the checkout's HEAD, serves it with a folder lock, and answers the five record tools from it. A
store that also holds a temporal reading of the commit serves the seven tools of decision 0032 from it;
one that does not answers those tools with the step's name. Each call is journaled with its size and the
files it covered.

**The wiki.** The server's answers are page models: `src/knowledge/repository-view.ts` builds them from
the store's reads, `KnowledgeProduct` answers `repositoryView`, `folderView`, `fileView`, `commitView` and
`runView`, and the app draws them at `/k`, `/k/folder`, `/k/file`, `/k/commit` and `/k/run`. The fill's
states are read from the run's trace by its run id; the run page reads the trace once (`readTraceRun`) and
states each step's wall clock, its sampled peak memory and its slowest names.

**The trace.** `src/obs/trace.ts` writes one JSON line per span in OTLP field names under
`<store>/traces`, samples the process's memory every 20 ms while a run is open, and states each span's
highest reading of its own window as `process.rss.peak`; `src/obs/progress.ts` reads a run's file as its
progress, and `src/obs/trace-report.ts` reads the time, the peaks and the slowest names.

**Git, its bytes and its gaps.** The passes stream git's own answers (`ls-tree`, `diff --numstat`,
`log --name-status/--numstat`), decode each record strictly as UTF-8, and name what they cannot read: a
tree path no text can be made from is a `non-utf8-path` gap, a history field is escaped as its bytes with
an `unreadable` gap, a shallow clone a `shallow-history` gap. A date git writes as `…Z` or `…+HH:MM` is
read as the instant and the offset git states. A run refuses a git older than the one the passes need,
naming both versions before it stands up.

## Acceptance evidence
Measured on `integrate-step1` (the branch of this change), as the ordinary user `shady` with `TZ=UTC`:

- `bun run check`: green — `tsc --noEmit`, the architecture check with **one-fill-entry 0** and the list
  unchanged at 1198 entries, the catalog (26 areas, 490 kinds), the workflows (4) and the static-stage
  boundaries.
- `bun run check:architecture-base --base e99c4ae3`: the list gained no entry since the base.
- `MADARCH_SKIP_PERF=1 bun test test/ --shard=<n>/5` (CI's own shard command): shard 1 **2755 pass, 172
  skip, 0 fail** (2936 tests in 208 files, 492.88 s); shard 3 **188 pass, 9 skip, 0 fail**; shard 4 **265
  pass, 2 skip, 0 fail**. Shards 2 and 5 were cut by the machine this ran on (its supervisor sends
  SIGTERM to long-lived children: two whole-suite runs ended `EXIT 143` with a log that stops mid-file);
  what was red in them was fixed and the files they were in the middle of were run to completion — 32
  pass (`product-daemon`, `own-wiki`), 138 pass (`product-wiki-serve`, `product-wiki-pages`,
  `server-http`), 81 pass and 9 skip (`wiki-walk`, `wiki-stages`, `knowledge-server`, `knowledge-sync`).
- The five PostgreSQL legs of CI's checks job: 3 + 16 + 26 + 54 + 7 pass, against PostgreSQL 16 with
  pgvector 0.8.7 built from source (the distro's 0.6.0 is refused by the adapter).
- `bun run views:check` (8 mermaid blocks in 8 pages, 1 likec4 file, 0 errors); `bun run contract:check`
  (54 registry, 7 document, 15 discussion, 54 manifest, 5 completeness cases, 3 products, 0 misread);
  `node .shady2k/checks/check-product.mjs --rev HEAD` (Product documents: clean).
- `wiki/app`: `bun install --frozen-lockfile && bun run check && bun test && bun run build` — **328
  pass, 0 fail**, and the build.
- `bun scripts/wiki-walk-ci.ts --baseline scripts/wiki-walk-baseline.json`: 20 entity pages, 12
  documents, 65 kind catalogues, **0 findings in every class**; "every class is at its baseline".
- The browser walk (`bun scripts/repository-view-walk.ts`) on the merged tree: ten screenshots — the
  empty wiki, the press, the progress, the end, the repository (reloaded), a folder, a file, a commit,
  the run page, and the file page at 1024 px and 390 px — each measured with 0 overflowing, 0 clipped and
  no text under 11 px.

## Where it is seen
Kind: command
Place: a product's wiki (`madarch serve` or `madarch demo`), `madarch fill-stages` in a product, and `madarch mcp` in a checkout

1. Open a product's wiki with an empty store: the page says the wiki is empty and offers the fill's one
   press; press it, and the card counts the units and spans the run's trace states until the home page
   becomes the repository the fill read, with its counts, its last fill's time and the root of its tree.
2. Open a folder, then a file: the folder lists its subfolders and its files, and the file shows its
   mode, blob, bytes, lines, text or binary, its language with every candidate, the commit and author
   that created it and last modified it, and its history; follow a commit, then a parent, and back to the
   file the commit changed.
3. Open the run page: each step's wall clock, its peak memory and its slowest names, and the run's own
   slowest names, all read from the run's trace.
4. Run `madarch fill-stages` in the product, then `madarch mcp` in a checkout from a client: ask
   `get_repository`, `list_files`, `get_file`, `get_file_history` and `get_commit` and each answer names
   the as-is commit, the changed paths and every gap; ask `get_symbol` and it answers that the step
   `syntax` has not run.

## DONE WHEN
One runner starts every fill and one list names its steps; a product has one store every surface resolves;
the record tables hold the repository's tree and history; `madarch mcp` answers the five repository tools
from that store and the seven later tools name their step; the wiki shows the empty state with the press,
the progress from the trace, the end state's counts and time, a failure's file and line, the repository,
its folders, its files and its commits, and the run page's per-step numbers; the git it reads is named
and refused when too old; git's bytes are read strictly and what cannot be read is a named gap; and the
suites whose cases read a stage out of the list are named with the stage that brings them back.
