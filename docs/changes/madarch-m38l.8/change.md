# The graph indexes the product's Markdown: pages, statements and their grounds are nodes and edges, so backlinks and changed grounds are queries

Change: madarch-m38l.8
Base: 290a1fa5fb3a9479e1e2aba0335341ed76c5d3ac
Tasks: madarch-m38l.8
Kind: no-behavior

## Intent
Decision 0029 says the graph indexes the product repository's Markdown together with the code facts. Today the agent's pages are read from Markdown on each request and joined in memory, a statement exists only as a footnote, and nothing records what a page was written from. This change makes the index real: on every fill and every page write one producer publishes, for the product repository's knowledge pages, page nodes, statement nodes (`statement-of` the page), `grounded-by` edges from each statement to its grounds (a graph key, or a document section node `path#anchor` with its text digest), `mentions` edges for entity links in the text and `relates` edges from the front matter. Deleting the graph and refilling restores the same nodes from the Markdown: the Markdown is the source, the graph is the index.

Three queries serve the wiki: the statements that rely on a graph key (the backlinks an entity page shows as "statements that rely on this entity"), the counts per kind for the catalogue, and the grounds that changed since a page was written (the digest of each ground at the page's written-at commit against now, recomputed from git and never stored in the page file).

The owner agreed two additions to the page format (2026-10-23), which this change makes in the writer and in the vertical's shared format, section 1:
- Named footnotes are stable statement ids: `[^refund-window]`. The writer generates a readable slug from the sentence, keeps a name while its sentence stands across rewrites, gives every statement its own footnote, and a page with numbered footnotes stays readable.
- The front matter records the page's basis, per repository the page was written from: `written-at: [{ repository, commit, branch, origin }]`. The engine turns origin, commit, path and lines into the web address on GitHub, GitLab, Bitbucket and Gitea/Forgejo, for ssh and https remotes; a host it does not know gets no link rather than a wrong one.

## Out of scope
- Drawing the backlinks, the catalogue counts and the "Open in GitHub" links in the wiki: the wiki app belongs to the walk-remarks task (madarch-m38l.4); this change delivers the queries and the link builder they call.
- Questions, answers and corrections as indexed kinds: the same mechanism, added when those pages exist.
- The incremental update that reacts to a changed ground (madarch-m38l.7): this change delivers the query it needs.
- A real agent run: it needs the owner's explicit yes with the agent and the cap.

## Rationale
The index is new modules under `src/knowledge/index` that depend on the graph store and on pure functions of the page; the writer calls it after a page is written, and a rebuild reads the Markdown from the product repository. The graph vocabulary gains four product relation types and three node kinds in the product namespace (`knowledge:` keys), so the engine's own namespaces are untouched.

## Preserved contracts
- product-repository/manifest: the manifest is read as before; the index adds no key to it.

## Coverage
- product-repository/manifest: test

## Where it is seen

Kind: command
Place: bun scripts/index-knowledge.ts, which rebuilds the graph index of a product's Markdown pages and prints its counts
Reason: the wiki that draws backlinks and changed grounds is another task's; today a person runs the rebuild and reads the counts.

1. A person runs `bun scripts/index-knowledge.ts --product /srv/training-product --store /srv/writer-store` after the writer ran.
2. The command prints the pages, statements, grounds, mentions and sections it indexed, and the statements whose grounds changed since the page was written.

## Blocking questions
None.

## Design and decisions
Decision 0029 and the vertical's shared formats. Choices inside them:
- The index is one producer, `knowledge.index`, in one scope node per product, with product-namespace kinds `knowledge:page`, `knowledge:statement`, `knowledge:section` and relation types `knowledge:statement-of`, `knowledge:grounded-by`, `knowledge:mentions`, `knowledge:relates`. Its nodes carry a `key` property, not `recordKey`, so the writer's view, its prompts and the wiki's entity lists do not see them.
- Each publication is complete (a statement the page no longer holds ends) at the valid time of the fill's last commit, and is skipped when its input is exactly what the graph already holds. A ground that resolves to nothing makes no edge and is returned in the report with its file and line.
- A statement is a sentence that ends in footnote references. A sentence with several references is one statement named by the first, grounded by all. Older pages whose footnote is shared by several sentences index as `name`, `name~2`, and so on.
- The digest on a `grounded-by` edge is a function of git at the page's written-at commit: a document section is the SHA-256 of its text; a symbol is the SHA-256 of the lines of its declaration span when the graph's span describes that commit, so an edit elsewhere in its file does not change it; anything else is git's object id of the path (a blob for a file, a tree for a folder). A span digest cannot be recomputed after the graph moves on, so a later index keeps the one it already holds for the same ground and commit; a rebuild into an empty graph falls back to the object id. A page that names no single repository has no digest, and the changed-grounds query says `unknown`, never `unchanged`.
- The writer, not the agent, writes `written-at` (`repository`, `commit`, `branch` when a branch is checked out, `origin` when the repository has an `origin` remote, credentials of an origin URL removed).
- Local `main` was behind `origin/main` by decision 0031's two commits at the start; Base is `origin/main` at the start, as the coordinator directed once local `main` was advanced.

### The read API (`src/knowledge/index/index.ts`) for the wiki
All reads take the graph's `DatabaseOwner` and answer from the current index; every list is in code-point order.
- `statementsRelyingOn(owner, key)`: the statements grounded on (`how: 'grounds'`) or only mentioning (`'mentions'`) a graph key, a page id (`domain:payments`) or a document section (`doc:docs/requirements.md#uc-2`). Each row: `page`, `pageTitle`, `pageKind`, `file`, `statement` (the footnote name), `text`, `line`. This is the entity page's "statements that rely on this entity".
- `indexCounts(owner)`: `{ kind, pages, statements }` per page kind, for the catalogue.
- `changedGrounds(owner, { commit, git }, { page? })`: every ground of every statement (or of one page) with `status` `changed | unchanged | removed | unknown`, the `method` of its digest, the page's `writtenCommit`, `before`/`after` digests and, for `unknown`, a `reason`. `commit` is the repository head the graph describes; `git` is `gitReader(repositoryPath)`.
- `webLink({ origin, commit, path, lineStart?, lineEnd? })`: `{ host: 'GitHub' | 'GitLab' | 'Bitbucket' | 'Gitea' | 'Forgejo', url }`, or `undefined` for a host not known. A page's `written-at` entries (`readIndexedPage(file, text, sha).writtenAt`) give `origin` and `commit`.
- `readKnowledgePages(productFolder)` and `readIndexedPage`: a page as the index reads it (`statements` with `id`, `text`, `line`, `grounds`, `mentions`).
- Publishing: `indexProductMarkdown` / `indexWorkerProduct` (run by the fill worker after the fill and after each page the writer writes; a product whose Markdown cannot be read whole publishes nothing and throws every finding with file and line).
- The index's nodes are `knowledge:page`, `knowledge:statement`, `knowledge:section` (property `key`: `page:<id>`, `statement:<page id>#<name>`, `section:<path>#<anchor>`); relations `knowledge:statement-of | grounded-by | mentions | relates`.

### The vertical's format, section 1, as changed (the file outside the repository is the coordinator's)
- Front matter gains an optional `written-at`, written by the writer, never by the agent:
  ```yaml
  written-at:
    - repository: services          # the repository's name in the product
      commit: 3f9c2a1...             # the commit the writer read, in full
      branch: main                   # when a branch is checked out
      origin: git@github.com:acme/shop.git   # the origin remote, without credentials
  ```
  The engine turns origin, commit, path and lines into the web address on GitHub, GitLab, Bitbucket and Gitea/Forgejo (https and ssh remotes); a host it does not know gets no link.
- A footnote belongs to one statement and is named for it, in lower-case words joined by hyphens: `Refunds are allowed within 14 days.[^refund-window]` with `[^refund-window]: [BR-4](madarch:doc:docs/requirements.md#br-4)`. The name is the statement's stable id in the graph. The writer renames a numbered footnote from the sentence, splits a footnote that several sentences share, keeps the name of a sentence that stands unchanged in the page it replaces, and lists the footnotes after the body in order of first use. Pages with numbered footnotes stay readable.

## Acceptance evidence
To be filled with the test runs on the pod.
